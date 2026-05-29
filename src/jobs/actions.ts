import type Database from 'better-sqlite3';

import { getJob, getJobEvents } from '../db/jobs.js';
import { getDeliveryAdapter, registerDeliveryAction } from '../delivery.js';
import type { Session } from '../types.js';
import { cancelJob, startJob } from './runner.js';

function textResponse(text: string): string {
  return JSON.stringify({ text });
}

async function deliverToOrigin(_session: Session, content: Record<string, unknown>, text: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  const channelType = (content.channelType as string | undefined) ?? null;
  const platformId = (content.platformId as string | undefined) ?? null;
  const threadId = (content.threadId as string | null | undefined) ?? null;
  if (!channelType || !platformId) return;
  await adapter.deliver(channelType, platformId, threadId, 'chat', textResponse(text));
}

function statusSummary(jobId: string): string {
  const job = getJob(jobId);
  if (!job) return `Job ${jobId} not found.`;
  const progress =
    job.progress_current !== null || job.progress_total !== null
      ? ` Progress: ${job.progress_current ?? '?'}/${job.progress_total ?? '?'}.`
      : '';
  const error = job.error ? ` Error: ${job.error}` : '';
  const recent = getJobEvents(jobId, { limit: 3 })
    .map((e) => e.message)
    .filter(Boolean)
    .join(' | ');
  return `Job ${job.id} (${job.type}) is ${job.status}.${progress}${error}${recent ? ` Recent: ${recent}` : ''}`;
}

registerDeliveryAction(
  'start_job',
  async (content: Record<string, unknown>, session: Session, _inDb: Database.Database) => {
    try {
      const job = startJob({
        type: String(content.type ?? ''),
        params: content.params ?? {},
        agentGroupId: session.agent_group_id,
        sessionId: session.id,
        messagingGroupId: session.messaging_group_id,
        channelType: (content.channelType as string | undefined) ?? null,
        platformId: (content.platformId as string | undefined) ?? null,
        threadId: (content.threadId as string | null | undefined) ?? null,
        requestedBy: (content.requestedBy as string | undefined) ?? null,
      });
      await deliverToOrigin(
        session,
        content,
        `Job ${job.id} started (${job.type}). I will send progress and a final result here.`,
      );
    } catch (err) {
      await deliverToOrigin(
        session,
        content,
        `Could not start job: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
);

registerDeliveryAction(
  'get_job_status',
  async (content: Record<string, unknown>, session: Session, _inDb: Database.Database) => {
    const jobId = String(content.jobId ?? '');
    await deliverToOrigin(session, content, jobId ? statusSummary(jobId) : 'Missing job id.');
  },
);

registerDeliveryAction(
  'cancel_job',
  async (content: Record<string, unknown>, session: Session, _inDb: Database.Database) => {
    const jobId = String(content.jobId ?? '');
    if (!jobId) {
      await deliverToOrigin(session, content, 'Missing job id.');
      return;
    }
    const job = cancelJob(jobId);
    await deliverToOrigin(
      session,
      content,
      job ? `Cancellation requested for job ${job.id}.` : `Job ${jobId} not found.`,
    );
  },
);
