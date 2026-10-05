/**
 * Durable job tools stamp every action with the session's own route, both on
 * the row and inside the content: the host reports job progress to that
 * route. Dropping the stamp would send confirmations and status nowhere.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { cancelJob, getJobStatus, startJob } from './jobs.js';

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO session_routing (id, channel_type, platform_id, thread_id, is_task)
       VALUES (1, 'telegram', 'telegram:42', 'thread-7', 0)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

function actions() {
  return getUndeliveredMessages().map((m) => ({
    platform_id: m.platform_id,
    channel_type: m.channel_type,
    thread_id: m.thread_id,
    content: JSON.parse(m.content) as Record<string, unknown>,
  }));
}

const route = { platformId: 'telegram:42', channelType: 'telegram', threadId: 'thread-7' };

describe('durable job tools', () => {
  it('start_job requires a type', async () => {
    const result = (await startJob.handler({})) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(actions()).toEqual([]);
  });

  it('start_job enqueues the action on the session route with defaulted params', async () => {
    await startJob.handler({ type: 'stock_market_screen' });
    expect(actions()).toEqual([
      {
        platform_id: 'telegram:42',
        channel_type: 'telegram',
        thread_id: 'thread-7',
        content: { action: 'start_job', type: 'stock_market_screen', params: {}, ...route },
      },
    ]);
  });

  it('status and cancel include job_id only when given', async () => {
    await getJobStatus.handler({});
    await cancelJob.handler({ job_id: 'job-1' });
    expect(actions().map((a) => a.content)).toEqual([
      { action: 'get_job_status', ...route },
      { action: 'cancel_job', jobId: 'job-1', ...route },
    ]);
  });
});
