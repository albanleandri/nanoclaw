import {
  getJobDeliveries,
  getJobEvents,
  listRecentJobs,
  markJobEventDelivered,
  type JobEventRecord,
  type JobRecord,
} from '../db/jobs.js';
import { getDeliveryAdapter } from '../delivery.js';
import { log } from '../log.js';
import { getJobType } from './registry.js';

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 5 * 60 * 1000;

let polling = false;
let pollMs = DEFAULT_POLL_MS;
let progressIntervalMs = DEFAULT_PROGRESS_INTERVAL_MS;

function parseTime(value: string): number {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function formatEvent(job: JobRecord, event: JobEventRecord, events: JobEventRecord[]): string {
  const definition = getJobType(job.type);
  if (event.level === 'progress') {
    const formatted = definition?.formatProgress?.(event);
    if (formatted) return formatted;
    if (event.message) return event.message;
    const current = job.progress_current ?? '?';
    const total = job.progress_total ?? '?';
    return `Progress: ${current}/${total}`;
  }
  if (event.level === 'final') {
    const formatted = definition?.formatFinal?.(job, events);
    if (formatted) return formatted;
    return event.message ?? `Job ${job.status}.`;
  }
  if (event.level === 'error') return event.message ?? `Job failed. Reference: ${job.id}`;
  return event.message ?? event.event_type;
}

function isTerminal(event: JobEventRecord): boolean {
  return event.level === 'final' || event.level === 'error';
}

function shouldDeliverEvent(
  job: JobRecord,
  event: JobEventRecord,
  delivered: ReturnType<typeof getJobDeliveries>,
  events: JobEventRecord[],
): boolean {
  if (event.level === 'progress' && events.some((e) => isTerminal(e) && e.seq > event.seq)) return false;
  if (delivered.some((d) => d.event_seq === event.seq)) return false;
  if (isTerminal(event)) return true;
  if (event.level !== 'progress') return false;

  const lastProgressDelivery = delivered
    .map((d) => parseTime(d.delivered_at))
    .filter((t) => t > 0)
    .sort((a, b) => b - a)[0];
  if (!lastProgressDelivery) return true;
  return Date.now() - lastProgressDelivery >= progressIntervalMs;
}

export async function deliverJobEventsOnce(): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;

  const jobs = listRecentJobs({ limit: 100 }).filter((job) => job.channel_type && job.platform_id);
  for (const job of jobs) {
    const delivered = getJobDeliveries(job.id);
    const events = getJobEvents(job.id, { limit: 500 });
    for (const event of events) {
      if (!shouldDeliverEvent(job, event, delivered, events)) continue;
      try {
        const platformMessageId = await adapter.deliver(
          job.channel_type!,
          job.platform_id!,
          job.thread_id,
          'chat',
          JSON.stringify({ text: formatEvent(job, event, events) }),
        );
        markJobEventDelivered(job.id, event.seq, { platformMessageId });
        delivered.push({
          job_id: job.id,
          event_seq: event.seq,
          message_out_id: null,
          platform_message_id: platformMessageId ?? null,
          delivered_at: new Date().toISOString(),
        });
      } catch (err) {
        log.warn('Job event delivery failed, will retry', { jobId: job.id, eventSeq: event.seq, err });
      }
    }
  }
}

export function startJobDeliveryPoll(options: { pollMs?: number; progressIntervalMs?: number } = {}): void {
  if (polling) return;
  polling = true;
  pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  void poll();
}

export function stopJobDeliveryPoll(): void {
  polling = false;
}

async function poll(): Promise<void> {
  if (!polling) return;
  try {
    await deliverJobEventsOnce();
  } catch (err) {
    log.error('Job delivery poll error', { err });
  }
  setTimeout(poll, pollMs);
}

export function setJobDeliveryProgressIntervalForTesting(ms: number): void {
  progressIntervalMs = ms;
}
