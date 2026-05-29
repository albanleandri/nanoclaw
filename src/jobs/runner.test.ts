import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';

import { createAgentGroup, closeDb, getJob, getJobEvents, initTestDb, runMigrations } from '../db/index.js';
import { clearJobTypesForTesting, registerJobType } from './registry.js';
import { cancelJob, getActiveJobIdsForTesting, resetJobsForTesting, startJob } from './runner.js';

function now() {
  return new Date().toISOString();
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

function registerNodeJob(script: string) {
  registerJobType({
    type: 'node_fixture',
    validateParams(params: unknown) {
      return params as { ok?: boolean };
    },
    buildCommand() {
      return {
        command: process.execPath,
        args: ['-e', script],
        cwd: path.resolve('.'),
      };
    },
  });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
});

afterEach(() => {
  resetJobsForTesting();
  clearJobTypesForTesting();
  closeDb();
});

describe('job runner', () => {
  it('runs a job and records JSONL progress and final result', async () => {
    registerNodeJob(`
      console.log(JSON.stringify({ type: 'progress', message: 'half', current: 1, total: 2, data: { batch: 1 } }));
      console.log(JSON.stringify({ type: 'final', message: 'done', data: { stored: 2 } }));
    `);

    const job = startJob({ id: 'job-1', type: 'node_fixture', agentGroupId: 'ag-1', params: { ok: true } });
    expect(job.status).toBe('running');

    await waitFor(() => getJob('job-1')?.status === 'succeeded' && getActiveJobIdsForTesting().length === 0);
    const finished = getJob('job-1')!;
    expect(finished.result).toEqual({ stored: 2 });
    expect(finished.progress_current).toBe(1);
    expect(finished.progress_total).toBe(2);
    expect(getJobEvents('job-1').map((e) => e.event_type)).toEqual(['started', 'progress', 'final']);
  });

  it('marks non-zero exits as failed', async () => {
    registerNodeJob(`process.exit(7);`);

    startJob({ id: 'job-1', type: 'node_fixture', agentGroupId: 'ag-1', params: {} });
    await waitFor(() => getJob('job-1')?.status === 'failed');

    expect(getJob('job-1')!.error).toContain('code 7');
    expect(getJobEvents('job-1').at(-1)!.event_type).toBe('failed');
  });

  it('records malformed stdout as warning events', async () => {
    registerNodeJob(`
      console.log('not-json');
      console.log(JSON.stringify({ type: 'final', data: { ok: true } }));
    `);

    startJob({ id: 'job-1', type: 'node_fixture', agentGroupId: 'ag-1', params: {} });
    await waitFor(() => getJob('job-1')?.status === 'succeeded' && getActiveJobIdsForTesting().length === 0);

    const warning = getJobEvents('job-1').find((e) => e.event_type === 'malformed_output');
    expect(warning).toBeDefined();
    expect(warning!.level).toBe('warning');
  });

  it('cancels a running job', async () => {
    registerNodeJob(`setInterval(() => {}, 1000);`);

    startJob({ id: 'job-1', type: 'node_fixture', agentGroupId: 'ag-1', params: {} });
    cancelJob('job-1');
    await waitFor(() => getJob('job-1')?.status === 'cancelled');

    expect(getJobEvents('job-1').map((e) => e.event_type)).toContain('cancelled');
  });

  it('rejects unknown job types before creating a DB row', () => {
    expect(() => startJob({ id: 'job-1', type: 'missing', agentGroupId: 'ag-1', params: {} })).toThrow(
      'Unknown job type',
    );
    expect(getJob('job-1')).toBeUndefined();
  });
});
