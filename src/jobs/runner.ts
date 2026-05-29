import { spawn, type ChildProcess } from 'child_process';

import {
  appendJobEvent,
  createJob,
  getJob,
  updateJobStatus,
  type JobEventLevel,
  type JobRecord,
  type JobStatus,
} from '../db/jobs.js';
import { getJobType } from './registry.js';
import type { ManagedJobEvent, StartJobInput } from './types.js';

const CANCEL_GRACE_MS = 5_000;

interface ActiveJob {
  child: ChildProcess;
  cancelling: boolean;
  killTimer?: NodeJS.Timeout;
}

const activeJobs = new Map<string, ActiveJob>();

function generateId(): string {
  return `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function eventId(jobId: string): string {
  return `evt-${jobId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function now(): string {
  return new Date().toISOString();
}

function levelFor(type: string, raw?: string): JobEventLevel {
  if (raw === 'info' || raw === 'progress' || raw === 'warning' || raw === 'error' || raw === 'final') return raw;
  if (type === 'progress') return 'progress';
  if (type === 'final') return 'final';
  if (type === 'error') return 'error';
  return 'info';
}

function appendRunnerEvent(jobId: string, event: ManagedJobEvent): void {
  const appended = appendJobEvent(jobId, {
    id: eventId(jobId),
    level: levelFor(event.type, event.level),
    eventType: event.type,
    message: event.message ?? null,
    data: event.data ?? null,
  });

  const patch: Parameters<typeof updateJobStatus>[1] = {};
  if (typeof event.current === 'number') patch.progressCurrent = event.current;
  if (typeof event.total === 'number') patch.progressTotal = event.total;
  if (event.type === 'final') {
    patch.status = 'succeeded';
    patch.result = event.data ?? null;
    patch.finishedAt = appended.created_at;
  } else if (event.type === 'error') {
    patch.error = event.message ?? 'Job error';
  }
  if (Object.keys(patch).length > 0) updateJobStatus(jobId, patch);
}

function handleJsonLine(jobId: string, line: string): void {
  if (!line.trim()) return;
  try {
    const parsed = JSON.parse(line) as ManagedJobEvent;
    if (!parsed || typeof parsed.type !== 'string') throw new Error('missing string type');
    appendRunnerEvent(jobId, parsed);
  } catch (err) {
    appendJobEvent(jobId, {
      id: eventId(jobId),
      level: 'warning',
      eventType: 'malformed_output',
      message: `Ignored malformed job output: ${err instanceof Error ? err.message : String(err)}`,
      data: { line: line.slice(0, 1000) },
    });
  }
}

function consumeLines(jobId: string, chunk: Buffer, state: { stdoutRemainder: string }): void {
  const text = state.stdoutRemainder + chunk.toString('utf8');
  const lines = text.split(/\r?\n/);
  state.stdoutRemainder = lines.pop() ?? '';
  for (const line of lines) handleJsonLine(jobId, line);
}

export function startJob(input: StartJobInput): JobRecord {
  const definition = getJobType(input.type);
  if (!definition) throw new Error(`Unknown job type: ${input.type}`);

  const params = definition.validateParams(input.params);
  const job = createJob({
    id: input.id ?? generateId(),
    type: input.type,
    agentGroupId: input.agentGroupId,
    sessionId: input.sessionId ?? null,
    messagingGroupId: input.messagingGroupId ?? null,
    channelType: input.channelType ?? null,
    platformId: input.platformId ?? null,
    threadId: input.threadId ?? null,
    requestedBy: input.requestedBy ?? null,
    params,
  });

  const command = definition.buildCommand({ jobId: job.id, agentGroupId: input.agentGroupId }, params);
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: { ...process.env, ...(command.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const active: ActiveJob = { child, cancelling: false };
  activeJobs.set(job.id, active);
  updateJobStatus(job.id, { status: 'running', startedAt: now() });
  appendJobEvent(job.id, { id: eventId(job.id), level: 'info', eventType: 'started', message: 'Job process started' });

  const state = { stdoutRemainder: '' };
  child.stdout.on('data', (chunk: Buffer) => consumeLines(job.id, chunk, state));
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim();
    if (!text) return;
    appendJobEvent(job.id, {
      id: eventId(job.id),
      level: 'warning',
      eventType: 'stderr',
      message: text.slice(0, 1000),
    });
  });

  child.on('error', (err) => {
    activeJobs.delete(job.id);
    updateJobStatus(job.id, { status: 'failed', error: err.message, finishedAt: now() });
    appendJobEvent(job.id, { id: eventId(job.id), level: 'error', eventType: 'spawn_error', message: err.message });
  });

  child.on('close', (code, signal) => {
    if (state.stdoutRemainder.trim()) handleJsonLine(job.id, state.stdoutRemainder);
    if (active.killTimer) clearTimeout(active.killTimer);
    activeJobs.delete(job.id);

    const current = getJob(job.id);
    if (active.cancelling) {
      updateJobStatus(job.id, { status: 'cancelled', finishedAt: now() });
      appendJobEvent(job.id, {
        id: eventId(job.id),
        level: 'final',
        eventType: 'cancelled',
        message: 'Job cancelled',
        data: { code, signal },
      });
      return;
    }

    if (current?.status === 'succeeded' || current?.status === 'failed' || current?.status === 'cancelled') return;

    if (code === 0) {
      updateJobStatus(job.id, { status: 'succeeded', finishedAt: now() });
      appendJobEvent(job.id, {
        id: eventId(job.id),
        level: 'final',
        eventType: 'completed_without_final_event',
        message: 'Job completed',
      });
    } else {
      const message = `Job exited with code ${code}${signal ? ` signal ${signal}` : ''}`;
      updateJobStatus(job.id, { status: 'failed', error: message, finishedAt: now() });
      appendJobEvent(job.id, { id: eventId(job.id), level: 'error', eventType: 'failed', message });
    }
  });

  return getJob(job.id)!;
}

export function cancelJob(jobId: string): JobRecord | undefined {
  const job = getJob(jobId);
  if (!job) return undefined;
  if (job.status !== 'queued' && job.status !== 'running') return job;

  const active = activeJobs.get(jobId);
  if (!active) {
    updateJobStatus(jobId, {
      status: 'cancelled',
      error: 'Job marked cancelled, but no active process was found',
      finishedAt: now(),
    });
    appendJobEvent(jobId, {
      id: eventId(jobId),
      level: 'final',
      eventType: 'cancelled_missing_process',
      message: 'Job cancelled; no active process was found',
    });
    return getJob(jobId);
  }

  active.cancelling = true;
  active.child.kill('SIGTERM');
  active.killTimer = setTimeout(() => {
    if (activeJobs.has(jobId)) active.child.kill('SIGKILL');
  }, CANCEL_GRACE_MS);
  appendJobEvent(jobId, {
    id: eventId(jobId),
    level: 'info',
    eventType: 'cancelling',
    message: 'Cancellation requested',
  });
  return getJob(jobId);
}

export function getActiveJobIdsForTesting(): string[] {
  return [...activeJobs.keys()];
}

export function resetJobsForTesting(): void {
  for (const active of activeJobs.values()) {
    if (active.killTimer) clearTimeout(active.killTimer);
    active.child.kill('SIGKILL');
  }
  activeJobs.clear();
}
