import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';

import type Database from 'better-sqlite3';

import { createAgentGroup, createSession, closeDb, getDb, getJob, initTestDb, runMigrations } from '../db/index.js';
import {
  clearDeliveryAdapterForTesting,
  handleSystemAction,
  setDeliveryAdapter,
  type ChannelDeliveryAdapter,
} from '../delivery.js';
import type { Session } from '../types.js';
import { recordSessionCapabilityAuthorization } from '../orchestration/run-store.js';
import { clearJobTypesForTesting, registerJobType } from './registry.js';
import { getActiveJobIdsForTesting, resetJobsForTesting } from './runner.js';
import './actions.js';

function now() {
  return new Date().toISOString();
}

function session(): Session {
  return {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: now(),
  };
}

function mockAdapter(deliveries: string[]): ChannelDeliveryAdapter {
  return {
    async deliver(_channelType, _platformId, _threadId, _kind, content) {
      deliveries.push(JSON.parse(content).text as string);
      return `platform-${deliveries.length}`;
    },
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for predicate'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function registerLongFixtureJob() {
  registerJobType({
    type: 'fixture_long',
    validateParams(params: unknown) {
      return params as Record<string, unknown>;
    },
    buildCommand() {
      return {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000);'],
        cwd: path.resolve('.'),
      };
    },
  });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  createSession(session());
  recordSessionCapabilityAuthorization('sess-1', ['nanoclaw.manage-jobs']);
  registerLongFixtureJob();
});

afterEach(() => {
  resetJobsForTesting();
  clearJobTypesForTesting();
  clearDeliveryAdapterForTesting();
  closeDb();
});

describe('job delivery actions', () => {
  it('starts a job from a system action and sends a user-facing confirmation without raw ids', async () => {
    const deliveries: string[] = [];
    setDeliveryAdapter(mockAdapter(deliveries));

    await handleSystemAction(
      {
        action: 'start_job',
        type: 'fixture_long',
        params: {},
        channelType: 'telegram',
        platformId: 'chat-1',
        threadId: null,
      },
      session(),
      getDb() as Database.Database,
    );

    expect(getActiveJobIdsForTesting()).toHaveLength(1);
    expect(deliveries).toEqual([
      'Job started. I will send progress here every few minutes and a final result when it is done.',
    ]);
  });

  it('reports and cancels the latest active job in the conversation without requiring a job id', async () => {
    const deliveries: string[] = [];
    setDeliveryAdapter(mockAdapter(deliveries));

    await handleSystemAction(
      {
        action: 'start_job',
        type: 'fixture_long',
        params: {},
        channelType: 'telegram',
        platformId: 'chat-1',
        threadId: null,
      },
      session(),
      getDb() as Database.Database,
    );
    const jobId = getActiveJobIdsForTesting()[0];

    await handleSystemAction(
      { action: 'get_job_status', channelType: 'telegram', platformId: 'chat-1', threadId: null },
      session(),
      getDb() as Database.Database,
    );
    await handleSystemAction(
      { action: 'cancel_job', channelType: 'telegram', platformId: 'chat-1', threadId: null },
      session(),
      getDb() as Database.Database,
    );
    await waitFor(() => getJob(jobId)?.status === 'cancelled');

    expect(deliveries.at(-2)).toBe('Job is running.');
    expect(deliveries.at(-1)).toBe('Job cancellation requested.');
  });
});
