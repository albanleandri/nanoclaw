import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup, createSession } from './index.js';
import {
  appendJobEvent,
  createJob,
  getJob,
  getJobDeliveries,
  getJobEvent,
  getJobEvents,
  getUndeliveredJobEvents,
  listRecentJobs,
  markJobEventDelivered,
  updateJobStatus,
} from './jobs.js';

function now() {
  return new Date().toISOString();
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Chat',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: 'thread-1',
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
});

describe('jobs DB helpers', () => {
  it('creates and reads a job with structured params', () => {
    const job = createJob({
      id: 'job-1',
      type: 'stock_market_screen',
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
      messagingGroupId: 'mg-1',
      channelType: 'telegram',
      platformId: 'telegram:123',
      threadId: 'thread-1',
      requestedBy: 'telegram:123',
      params: { tickers: ['AAPL', 'MSFT'], batchSize: 50 },
    });

    expect(job.status).toBe('queued');
    expect(job.params).toEqual({ tickers: ['AAPL', 'MSFT'], batchSize: 50 });
    expect(getJob('job-1')!.platform_id).toBe('telegram:123');
  });

  it('lists recent jobs by agent group and status', () => {
    createJob({ id: 'job-1', type: 'a', agentGroupId: 'ag-1', params: {}, status: 'queued' });
    createJob({ id: 'job-2', type: 'a', agentGroupId: 'ag-1', params: {}, status: 'running' });

    expect(listRecentJobs({ agentGroupId: 'ag-1' }).map((j) => j.id)).toEqual(['job-2', 'job-1']);
    expect(listRecentJobs({ status: 'running' }).map((j) => j.id)).toEqual(['job-2']);
  });

  it('updates status, result, progress, timestamps, and JSON result', () => {
    createJob({ id: 'job-1', type: 'a', agentGroupId: 'ag-1', params: {} });
    const startedAt = '2026-05-29T10:00:00.000Z';
    const finishedAt = '2026-05-29T10:05:00.000Z';

    updateJobStatus('job-1', {
      status: 'succeeded',
      result: { stored: 2 },
      error: null,
      progressCurrent: 2,
      progressTotal: 2,
      startedAt,
      finishedAt,
    });

    const job = getJob('job-1')!;
    expect(job.status).toBe('succeeded');
    expect(job.result).toEqual({ stored: 2 });
    expect(job.progress_current).toBe(2);
    expect(job.progress_total).toBe(2);
    expect(job.started_at).toBe(startedAt);
    expect(job.finished_at).toBe(finishedAt);
  });

  it('appends events with monotonic per-job seq and structured data', () => {
    createJob({ id: 'job-1', type: 'a', agentGroupId: 'ag-1', params: {} });

    const first = appendJobEvent('job-1', {
      id: 'evt-1',
      level: 'progress',
      eventType: 'batch_complete',
      message: 'Batch 1 complete',
      data: { batch: 1 },
    });
    const second = appendJobEvent('job-1', {
      id: 'evt-2',
      level: 'final',
      eventType: 'complete',
      data: { stored: 2 },
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(getJobEvents('job-1')).toEqual([first, second]);
    expect(getJobEvents('job-1', { afterSeq: 1 })).toEqual([second]);
    expect(getJobEvent(second.id)).toEqual(second);
    expect(getJobEvent('missing')).toBeUndefined();
  });

  it('marks event delivery idempotently and lists undelivered events', () => {
    createJob({ id: 'job-1', type: 'a', agentGroupId: 'ag-1', params: {} });
    appendJobEvent('job-1', { id: 'evt-1', level: 'progress', eventType: 'progress' });
    appendJobEvent('job-1', { id: 'evt-2', level: 'final', eventType: 'final' });

    markJobEventDelivered('job-1', 1, { platformMessageId: 'tg-msg-1' });
    markJobEventDelivered('job-1', 1, { platformMessageId: 'tg-msg-duplicate' });

    expect(getJobDeliveries('job-1')).toHaveLength(1);
    expect(getJobDeliveries('job-1')[0].platform_message_id).toBe('tg-msg-1');
    expect(getUndeliveredJobEvents('job-1').map((e) => e.seq)).toEqual([2]);
  });

  it('cascades job events when the job is deleted', () => {
    createJob({ id: 'job-1', type: 'a', agentGroupId: 'ag-1', params: {} });
    appendJobEvent('job-1', { id: 'evt-1', level: 'info', eventType: 'created' });
    markJobEventDelivered('job-1', 1);

    closeDb();
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
    const job = createJob({ id: 'job-delete', type: 'a', agentGroupId: 'ag-1', params: {} });
    appendJobEvent(job.id, { id: 'evt-delete', level: 'info', eventType: 'created' });
    db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
    expect(getJobEvents(job.id)).toEqual([]);
  });
});
