import type Database from 'better-sqlite3';

import { getJob, getJobEvents, listRecentJobs, type JobRecord } from '../db/jobs.js';
import { getDeliveryAdapter, registerDeliveryAction } from '../delivery.js';
import type { Session } from '../types.js';
import { authorizeChannelDestination } from '../channel-destination-auth.js';
import { getJobType } from './registry.js';
import { cancelJob, startJob } from './runner.js';

function textResponse(text: string): string {
  return JSON.stringify({ text });
}

interface AuthorizedJobRoute {
  messagingGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
}

function resolveAuthorizedRoute(session: Session, content: Record<string, unknown>): AuthorizedJobRoute {
  const channelType = typeof content.channelType === 'string' ? content.channelType : '';
  const platformId = typeof content.platformId === 'string' ? content.platformId : '';
  if (!channelType || !platformId) throw new Error('job action is missing channel routing');
  const messagingGroup = authorizeChannelDestination(session, channelType, platformId);
  return {
    messagingGroupId: messagingGroup.id,
    channelType: messagingGroup.channel_type,
    platformId: messagingGroup.platform_id,
    threadId: typeof content.threadId === 'string' ? content.threadId : null,
  };
}

async function deliverToOrigin(route: AuthorizedJobRoute, text: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  await adapter.deliver(route.channelType, route.platformId, route.threadId, 'chat', textResponse(text));
}

function publicJobName(job: JobRecord): string {
  if (job.type === 'stock_market_screen') return 'Screen';
  return 'Job';
}

function findConversationJob(content: Record<string, unknown>, session: Session): JobRecord | undefined {
  const explicit = typeof content.jobId === 'string' && content.jobId.trim() ? getJob(content.jobId.trim()) : undefined;
  if (explicit) return explicit.agent_group_id === session.agent_group_id ? explicit : undefined;

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
    const route = resolveAuthorizedRoute(session, content);
    try {
      const job = startJob({
        type: String(content.type ?? ''),
        params: content.params ?? {},
        agentGroupId: session.agent_group_id,
        sessionId: session.id,
        messagingGroupId: route.messagingGroupId,
        channelType: route.channelType,
        platformId: route.platformId,
        threadId: route.threadId,
        requestedBy: (content.requestedBy as string | undefined) ?? null,
      });
      const label = job.type === 'stock_market_screen' ? 'Screen' : 'Job';
      await deliverToOrigin(
        route,
        `${label} started. I will send progress here every few minutes and a final result when it is done.`,
      );
    } catch (err) {
      await deliverToOrigin(route, `Could not start job: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

registerDeliveryAction(
  'get_job_status',
  async (content: Record<string, unknown>, session: Session, _inDb: Database.Database) => {
    const route = resolveAuthorizedRoute(session, content);
    const job = findConversationJob(content, session);
    await deliverToOrigin(route, job ? statusSummary(job) : 'No active job found for this conversation.');
  },
);

registerDeliveryAction(
  'cancel_job',
  async (content: Record<string, unknown>, session: Session, _inDb: Database.Database) => {
    const route = resolveAuthorizedRoute(session, content);
    const target = findConversationJob(content, session);
    if (!target) {
      await deliverToOrigin(route, 'No active job found for this conversation.');
      return;
    }
    if (target.type === 'agent_task') {
      await deliverToOrigin(route, 'Use cancel_agent_task for durable delegated tasks.');
      return;
    }
    const job = cancelJob(target.id);
    await deliverToOrigin(route, job ? `${publicJobName(job)} cancellation requested.` : 'Job not found.');
  },
);
