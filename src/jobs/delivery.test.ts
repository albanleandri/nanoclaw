import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createAgentGroup, closeDb, createJob, getJobDeliveries, initTestDb, runMigrations } from '../db/index.js';
import { appendJobEvent } from '../db/jobs.js';
import { clearDeliveryAdapterForTesting, setDeliveryAdapter, type ChannelDeliveryAdapter } from '../delivery.js';
import { deliverJobEventsOnce, setJobDeliveryProgressIntervalForTesting, stopJobDeliveryPoll } from './delivery.js';

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
  setJobDeliveryProgressIntervalForTesting(5 * 60 * 1000);
});

afterEach(() => {
  stopJobDeliveryPoll();
  clearDeliveryAdapterForTesting();
  closeDb();
});

describe('job delivery', () => {
  it('delivers the first progress event once', async () => {
    const deliveries: string[] = [];
    setDeliveryAdapter(mockAdapter(deliveries));
    createJob({
      id: 'job-1',
      type: 'fixture',
      agentGroupId: 'ag-1',
      params: {},
      channelType: 'telegram',
      platformId: 'telegram:123',
      threadId: 'thread-1',
    });
    appendJobEvent('job-1', { id: 'evt-1', level: 'progress', eventType: 'progress', message: 'Batch 1 done' });

    await deliverJobEventsOnce();
    await deliverJobEventsOnce();

    expect(deliveries).toEqual(['Job job-1: Batch 1 done']);
    expect(getJobDeliveries('job-1')).toHaveLength(1);
  });

  it('does not deliver throttled progress events before the interval', async () => {
    const deliveries: string[] = [];
    setDeliveryAdapter(mockAdapter(deliveries));
    createJob({
      id: 'job-1',
      type: 'fixture',
      agentGroupId: 'ag-1',
      params: {},
      channelType: 'telegram',
      platformId: 'telegram:123',
    });
    appendJobEvent('job-1', { id: 'evt-1', level: 'progress', eventType: 'progress', message: 'Batch 1 done' });
    appendJobEvent('job-1', { id: 'evt-2', level: 'progress', eventType: 'progress', message: 'Batch 2 done' });

    await deliverJobEventsOnce();
    await deliverJobEventsOnce();

    expect(deliveries).toEqual(['Job job-1: Batch 1 done']);
  });

  it('always delivers final events after progress', async () => {
    const deliveries: string[] = [];
    setDeliveryAdapter(mockAdapter(deliveries));
    createJob({
      id: 'job-1',
      type: 'fixture',
      agentGroupId: 'ag-1',
      params: {},
      channelType: 'telegram',
      platformId: 'telegram:123',
    });
    appendJobEvent('job-1', { id: 'evt-1', level: 'progress', eventType: 'progress', message: 'Batch 1 done' });
    appendJobEvent('job-1', { id: 'evt-2', level: 'final', eventType: 'final', message: 'Complete' });

    await deliverJobEventsOnce();

    expect(deliveries).toEqual(['Job job-1: Batch 1 done', 'Job job-1: Complete']);
    expect(getJobDeliveries('job-1')).toHaveLength(2);
  });

  it('leaves events pending when no adapter is set', async () => {
    clearDeliveryAdapterForTesting();
    createJob({
      id: 'job-1',
      type: 'fixture',
      agentGroupId: 'ag-1',
      params: {},
      channelType: 'telegram',
      platformId: 'telegram:123',
    });
    appendJobEvent('job-1', { id: 'evt-1', level: 'progress', eventType: 'progress', message: 'Batch 1 done' });

    await deliverJobEventsOnce();

    expect(getJobDeliveries('job-1')).toEqual([]);
  });
});
