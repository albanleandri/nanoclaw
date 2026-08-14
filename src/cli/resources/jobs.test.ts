import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { clearJobTypesForTesting, registerJobType } from '../../jobs/registry.js';
import { resetJobsForTesting } from '../../jobs/runner.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import './jobs.js';

function agentCtx(group = 'ag-1'): CallerContext {
  return { caller: 'agent', agentGroupId: group, sessionId: `sess-${group}`, messagingGroupId: '' };
}

describe('jobs CLI resource', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    for (const id of ['ag-1', 'ag-2']) {
      createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
      createSession({
        id: `sess-${id}`,
        agent_group_id: id,
        messaging_group_id: null,
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'stopped',
        last_active: null,
        created_at: new Date().toISOString(),
      });
    }
    clearJobTypesForTesting();
    registerJobType({
      type: 'test_job',
      validateParams: (value) => value,
      buildCommand: () => ({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 10000)'],
        cwd: process.cwd(),
      }),
    });
  });

  afterEach(() => {
    resetJobsForTesting();
    closeDb();
  });

  it('starts a host-managed job for the calling agent group', async () => {
    const response = await dispatch(
      { id: 'start', command: 'jobs-start', args: { type: 'test_job', params: '{"scope":"weekly"}' } },
      agentCtx(),
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data).toMatchObject({ agent_group_id: 'ag-1', type: 'test_job', reused: false });
  });

  it('deduplicates an already-active job of the same type by default', async () => {
    const first = await dispatch({ id: 'one', command: 'jobs-start', args: { type: 'test_job' } }, agentCtx());
    const second = await dispatch({ id: 'two', command: 'jobs-start', args: { type: 'test_job' } }, agentCtx());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data).toMatchObject({ id: (first.data as { id: string }).id, reused: true });
  });

  it('does not let an agent start a job for another group', async () => {
    const response = await dispatch(
      { id: 'cross-tenant', command: 'jobs-start', args: { type: 'test_job', agent_group_id: 'ag-2' } },
      agentCtx('ag-1'),
    );
    expect(response).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });
});
