import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  createAgentGroup,
  closeDb,
  createJob,
  createMessagingGroup,
  createSession,
  getDb,
  getJobDeliveries,
  initTestDb,
  runMigrations,
} from '../db/index.js';
import { appendJobEvent, markJobEventDelivered } from '../db/jobs.js';
import { registerJobType } from './registry.js';
import { clearDeliveryAdapterForTesting, setDeliveryAdapter, type ChannelDeliveryAdapter } from '../delivery.js';
import {
  deliverJobEventsOnce,
  JOB_DELIVERY_DEFAULT_PROGRESS_INTERVAL_MS,
  setJobDeliveryProgressIntervalForTesting,
  stopJobDeliveryPoll,
} from './delivery.js';

function now() {
  return new Date().toISOString();
}

function mockAdapter(deliveries: string[]): ChannelDeliveryAdapter {
  return {
    async deliver(_channelType, _platformId, _threadId, _kind, content) {
      deliveries.push(JSON.parse(content).text as string);
      return `platform-${deliveries.length}`;
    },
  };
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
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  setJobDeliveryProgressIntervalForTesting(JOB_DELIVERY_DEFAULT_PROGRESS_INTERVAL_MS);
});

afterEach(() => {
  stopJobDeliveryPoll();
  clearDeliveryAdapterForTesting();
  closeDb();
});

describe('job delivery', () => {
  it('leaves events pending when a persisted route is not authorized for the source session', async () => {
    const deliveries: string[] = [];
    setDeliveryAdapter(mockAdapter(deliveries));
    createJob({
      id: 'job-1',
      type: 'fixture',
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
      messagingGroupId: 'mg-1',
      params: {},
      channelType: 'telegram',
      platformId: 'attacker-chat',
    });
    appendJobEvent('job-1', { id: 'evt-1', level: 'final', eventType: 'final', message: 'Complete' });

    await deliverJobEventsOnce();

    expect(deliveries).toEqual([]);
    expect(getJobDeliveries('job-1')).toEqual([]);
  });

  it('delivers the first progress event once', async () => {
    const deliveries: string[] = [];
    setDeliveryAdapter(mockAdapter(deliveries));
    createJob({
      id: 'job-1',
      type: 'fixture',
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
      messagingGroupId: 'mg-1',
      params: {},
      channelType: 'telegram',
      platformId: 'telegram:123',
      threadId: 'thread-1',
    });
    appendJobEvent('job-1', { id: 'evt-1', level: 'progress', eventType: 'progress', message: 'Batch 1 done' });

    await deliverJobEventsOnce();
    await deliverJobEventsOnce();

    expect(deliveries).toEqual(['Batch 1 done']);
    expect(getJobDeliveries('job-1')).toHaveLength(1);
  });

  it('delivers the latest progress snapshot instead of stale queued progress', async () => {
    const deliveries: string[] = [];
    setDeliveryAdapter(mockAdapter(deliveries));
    createJob({
      id: 'job-1',
      type: 'fixture',
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
      messagingGroupId: 'mg-1',
      params: {},
      channelType: 'telegram',
      platformId: 'telegram:123',
    });
    appendJobEvent('job-1', { id: 'evt-1', level: 'progress', eventType: 'progress', message: 'Batch 1 done' });
    appendJobEvent('job-1', { id: 'evt-2', level: 'progress', eventType: 'progress', message: 'Batch 2 done' });

    await deliverJobEventsOnce();
    await deliverJobEventsOnce();

    expect(deliveries).toEqual(['Batch 2 done']);
    expect(getJobDeliveries('job-1').map((delivery) => delivery.event_seq)).toEqual([2]);
  });

  it('uses a one-minute default progress interval', async () => {
    expect(JOB_DELIVERY_DEFAULT_PROGRESS_INTERVAL_MS).toBe(60 * 1000);
  });

  it('delivers the latest pending progress after the default interval', async () => {
    const deliveries: string[] = [];
    setDeliveryAdapter(mockAdapter(deliveries));
    createJob({
      id: 'job-1',
      type: 'fixture',
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
      messagingGroupId: 'mg-1',
      params: {},
      channelType: 'telegram',
      platformId: 'telegram:123',
    });
    appendJobEvent('job-1', { id: 'evt-1', level: 'progress', eventType: 'progress', message: 'Batch 1 done' });

    await deliverJobEventsOnce();
    getDb()
      .prepare('UPDATE job_deliveries SET delivered_at = ? WHERE job_id = ? AND event_seq = ?')
      .run(new Date(Date.now() - JOB_DELIVERY_DEFAULT_PROGRESS_INTERVAL_MS - 1000).toISOString(), 'job-1', 1);
    appendJobEvent('job-1', { id: 'evt-2', level: 'progress', eventType: 'progress', message: 'Batch 2 done' });
    appendJobEvent('job-1', { id: 'evt-3', level: 'progress', eventType: 'progress', message: 'Batch 3 done' });
    await deliverJobEventsOnce();

    expect(deliveries).toEqual(['Batch 1 done', 'Batch 3 done']);
    expect(getJobDeliveries('job-1').map((delivery) => delivery.event_seq)).toEqual([1, 3]);
  });

  it('always delivers final events after progress', async () => {
    const deliveries: string[] = [];
    setDeliveryAdapter(mockAdapter(deliveries));
    createJob({
      id: 'job-1',
      type: 'fixture',
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
      messagingGroupId: 'mg-1',
      params: {},
      channelType: 'telegram',
      platformId: 'telegram:123',
    });
    appendJobEvent('job-1', { id: 'evt-1', level: 'progress', eventType: 'progress', message: 'Batch 1 done' });
    appendJobEvent('job-1', { id: 'evt-2', level: 'final', eventType: 'final', message: 'Complete' });

    await deliverJobEventsOnce();

    expect(deliveries).toEqual(['Complete']);
    expect(getJobDeliveries('job-1')).toHaveLength(1);
  });

  it('does not deliver stale progress after a terminal event has already been delivered', async () => {
    const deliveries: string[] = [];
    setDeliveryAdapter(mockAdapter(deliveries));
    setJobDeliveryProgressIntervalForTesting(0);
    createJob({
      id: 'job-1',
      type: 'fixture',
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
      messagingGroupId: 'mg-1',
      params: {},
      channelType: 'telegram',
      platformId: 'telegram:123',
    });
    appendJobEvent('job-1', { id: 'evt-1', level: 'progress', eventType: 'progress', message: 'Batch 1 done' });
    appendJobEvent('job-1', { id: 'evt-2', level: 'progress', eventType: 'progress', message: 'Batch 2 done' });
    appendJobEvent('job-1', { id: 'evt-3', level: 'final', eventType: 'final', message: 'Complete' });
    markJobEventDelivered('job-1', 1, { platformMessageId: 'platform-1' });
    markJobEventDelivered('job-1', 3, { platformMessageId: 'platform-3' });
    getDb()
      .prepare("UPDATE job_deliveries SET delivered_at = '2026-05-29T21:36:22.000Z' WHERE job_id = ?")
      .run('job-1');

    await deliverJobEventsOnce();

    expect(deliveries).toEqual([]);
    expect(getJobDeliveries('job-1').map((delivery) => delivery.event_seq)).toEqual([1, 3]);
  });

  it('uses job-type progress formatting and does not expose the job id in routine progress', async () => {
    const deliveries: string[] = [];
    setDeliveryAdapter(mockAdapter(deliveries));
    registerJobType({
      type: 'friendly_fixture',
      validateParams: (params) => params,
      buildCommand: () => ({ command: 'node', args: ['-e', ''], cwd: process.cwd() }),
      formatProgress: () => 'Screen progress: 50/100 tickers. Batch 1/2. 49 stored, 1 failed.',
      formatFinal: () => 'Screen complete: 99/100 stored.',
    });
    createJob({
      id: 'job-1',
      type: 'friendly_fixture',
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
      messagingGroupId: 'mg-1',
      params: {},
      channelType: 'telegram',
      platformId: 'telegram:123',
    });
    appendJobEvent('job-1', { id: 'evt-1', level: 'progress', eventType: 'progress', message: 'raw progress' });
    appendJobEvent('job-1', { id: 'evt-2', level: 'final', eventType: 'final', message: 'raw final' });

    await deliverJobEventsOnce();

    expect(deliveries).toEqual(['Screen complete: 99/100 stored.']);
    expect(deliveries.join('\n')).not.toContain('job-1');
  });

  it('leaves events pending when no adapter is set', async () => {
    clearDeliveryAdapterForTesting();
    createJob({
      id: 'job-1',
      type: 'fixture',
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
      messagingGroupId: 'mg-1',
      params: {},
      channelType: 'telegram',
      platformId: 'telegram:123',
    });
    appendJobEvent('job-1', { id: 'evt-1', level: 'progress', eventType: 'progress', message: 'Batch 1 done' });

    await deliverJobEventsOnce();

    expect(getJobDeliveries('job-1')).toEqual([]);
  });
});
