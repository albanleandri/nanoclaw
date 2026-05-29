import type Database from 'better-sqlite3';

import { getJob, getJobEvents, listRecentJobs, type JobRecord } from '../db/jobs.js';
import { getDeliveryAdapter, registerDeliveryAction } from '../delivery.js';
import type { Session } from '../types.js';
import { getJobType } from './registry.js';
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

function publicJobName(job: JobRecord): string {
  if (job.type === 'stock_market_screen') return 'Screen';
  return 'Job';
}

function findConversationJob(content: Record<string, unknown>, session: Session): JobRecord | undefined {
  const explicit = typeof content.jobId === 'string' && content.jobId.trim() ? getJob(content.jobId.trim()) : undefined;
  if (explicit) return explicit;

  const channelType = (content.channelType as string | undefined) ?? null;
  const platformId = (content.platformId as string | undefined) ?? null;
  const threadId = (content.threadId as string | null | undefined) ?? null;
  return listRecentJobs({ agentGroupId: session.agent_group_id, limit: 20 }).find((job) => {
    if (job.status !== 'running' && job.status !== 'queued') return false;
    if (channelType && job.channel_type !== channelType) return false;
    if (platformId && job.platform_id !== platformId) return false;
    if (threadId !== null && job.thread_id !== threadId) return false;
    return true;
  });
}

function statusSummary(job: JobRecord): string {
  const progress =
    job.progress_current !== null || job.progress_total !== null
      ? ` ${job.progress_current ?? '?'}/${job.progress_total ?? '?'} tickers processed.`
      : '';
  const error = job.error ? ` Error: ${job.error}` : '';
  const events = getJobEvents(job.id, { limit: 20 });
  const latestProgress = [...events].reverse().find((event) => event.level === 'progress');
  const formatted = latestProgress ? getJobType(job.type)?.formatProgress?.(latestProgress) : null;
  if (formatted) return `${publicJobName(job)} is ${job.status}. ${formatted}${error}`;
  return `${publicJobName(job)} is ${job.status}.${progress}${error}`;
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
      const label = job.type === 'stock_market_screen' ? 'Screen' : 'Job';
      await deliverToOrigin(
        session,
        content,
        `${label} started. I will send progress here every few minutes and a final result when it is done.`,
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
    const job = findConversationJob(content, session);
    await deliverToOrigin(session, content, job ? statusSummary(job) : 'No active job found for this conversation.');
  },
);

registerDeliveryAction(
  'cancel_job',
  async (content: Record<string, unknown>, session: Session, _inDb: Database.Database) => {
    const target = findConversationJob(content, session);
    if (!target) {
      await deliverToOrigin(session, content, 'No active job found for this conversation.');
      return;
    }
    const job = cancelJob(target.id);
    await deliverToOrigin(session, content, job ? `${publicJobName(job)} cancellation requested.` : 'Job not found.');
  },
);
