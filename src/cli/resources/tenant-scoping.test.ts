/**
 * Cross-tenant isolation for the read-oriented CLI resources.
 *
 * audit-events, auxiliary-routes and orchestration-runs each re-implement the
 * same `scope()` guard: an agent caller may only ever address its OWN agent
 * group, and a host caller must name a group explicitly. All three were
 * completely uncovered, so a copy-paste slip in any one of them — returning
 * `requested` instead of `ctx.agentGroupId`, or dropping the mismatch check —
 * would have leaked another tenant's audit trail or run history silently.
 *
 * These are `access: 'open'` operations, so an agent caller reaches the
 * handler directly with no approval interstitial; the guard inside the
 * resource is the only thing standing between tenants.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import type { CallerContext } from '../frame.js';
import { dispatch } from '../dispatch.js';
// Side-effect imports: register the commands under test.
import './audit-events.js';
import './auxiliary-routes.js';
import './orchestration-runs.js';

const MINE = 'ag-mine';
const THEIRS = 'ag-theirs';
const SESSION = 'sess-mine-1';

function now(): string {
  return new Date().toISOString();
}

/** Agent caller for MINE, with global CLI scope so dispatch's own group-scope
 *  filter steps aside and the resource's `scope()` guard is what gets tested. */
const agentCtx: CallerContext = {
  caller: 'agent',
  sessionId: SESSION,
  agentGroupId: MINE,
  messagingGroupId: 'mg-1',
};

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);

  for (const id of [MINE, THEIRS]) {
    createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
    ensureContainerConfig(id);
    updateContainerConfigScalars(id, { cli_scope: 'global' });
  }

  createSession({
    id: SESSION,
    agent_group_id: MINE,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
});

afterEach(() => closeDb());

describe.each([
  ['audit-events-list', 'audit-events'],
  ['auxiliary-routes-list', 'auxiliary-routes'],
  ['orchestration-runs-list', 'orchestration-runs'],
])('%s tenant scoping', (command, resource) => {
  it(`refuses an agent caller that names another agent group`, async () => {
    const resp = await dispatch({ id: 'r1', command, args: { agent_group_id: THEIRS } }, agentCtx);

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/another agent/i);
  });

  it(`allows an agent caller to address its own group explicitly`, async () => {
    const resp = await dispatch({ id: 'r2', command, args: { agent_group_id: MINE } }, agentCtx);

    expect(resp.ok).toBe(true);
  });

  it(`defaults an agent caller to its own group when none is named`, async () => {
    const resp = await dispatch({ id: 'r3', command, args: {} }, agentCtx);

    expect(resp.ok).toBe(true);
  });

  it(`requires a host caller to name a group rather than defaulting to all tenants`, async () => {
    const resp = await dispatch({ id: 'r4', command, args: {} }, { caller: 'host' });

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/agent-group-id is required/i);
    expect(`${resource}`).toBeTruthy();
  });
});

describe('orchestration-runs list — status filter validation', () => {
  it('rejects an unknown status instead of passing it into the query', async () => {
    const resp = await dispatch(
      { id: 'r5', command: 'orchestration-runs-list', args: { agent_group_id: MINE, status: 'bogus' } },
      agentCtx,
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/Invalid orchestration run status/i);
  });

  it.each(['queued', 'running', 'succeeded', 'failed', 'cancelled'])('accepts the %s status', async (status) => {
    const resp = await dispatch(
      { id: `r-${status}`, command: 'orchestration-runs-list', args: { agent_group_id: MINE, status } },
      agentCtx,
    );

    expect(resp.ok).toBe(true);
  });
});

describe('orchestration-runs cancel', () => {
  it('requires a run id', async () => {
    const resp = await dispatch({ id: 'r6', command: 'orchestration-runs-cancel', args: {} }, agentCtx);

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/--id is required/i);
  });

  it('does not cancel a run belonging to another agent group', async () => {
    // An agent caller is pinned to its own group id, so a cross-tenant run id
    // must not resolve — regardless of whether that run exists.
    const resp = await dispatch(
      { id: 'r7', command: 'orchestration-runs-cancel', args: { id: 'run-owned-by-theirs' } },
      agentCtx,
    );

    // Either a clean "not found" or an explicit refusal is acceptable; silently
    // cancelling another tenant's run is not.
    if (resp.ok) {
      expect(resp.data).toMatchObject({ cancelled: false });
    } else {
      expect(resp.error.message).toBeTruthy();
    }
  });
});

describe('auxiliary-routes', () => {
  it('rejects an unknown role', async () => {
    const resp = await dispatch(
      { id: 'r8', command: 'auxiliary-routes-get', args: { agent_group_id: MINE, role: 'not-a-role' } },
      agentCtx,
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/--role must be one of/i);
  });

  it('reports a missing route as disabled rather than erroring', async () => {
    const resp = await dispatch(
      { id: 'r9', command: 'auxiliary-routes-get', args: { agent_group_id: MINE, role: 'vision' } },
      agentCtx,
    );

    expect(resp.ok).toBe(true);
  });

  it('scopes search-status to the caller group', async () => {
    const mineResp = await dispatch({ id: 'r10', command: 'auxiliary-routes-search-status', args: {} }, agentCtx);
    expect(mineResp.ok).toBe(true);
    if (mineResp.ok) expect(mineResp.data).toMatchObject({ agent_group_id: MINE });

    const theirsResp = await dispatch(
      { id: 'r11', command: 'auxiliary-routes-search-status', args: { agent_group_id: THEIRS } },
      agentCtx,
    );
    expect(theirsResp.ok).toBe(false);
  });

  it('set is gated behind approval for an agent caller and never applies directly', async () => {
    const resp = await dispatch(
      {
        id: 'r12',
        command: 'auxiliary-routes-set',
        args: { agent_group_id: MINE, role: 'vision', kind: 'main' },
      },
      agentCtx,
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('approval-pending');

    // The route must still be unset — approval-pending must not have applied it.
    const after = await dispatch(
      { id: 'r13', command: 'auxiliary-routes-list', args: { agent_group_id: MINE } },
      agentCtx,
    );
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.data).toEqual([]);
  });

  it('host caller can set and read back a route', async () => {
    const setResp = await dispatch(
      {
        id: 'r14',
        command: 'auxiliary-routes-set',
        args: { agent_group_id: MINE, role: 'vision', kind: 'main' },
      },
      { caller: 'host' },
    );
    expect(setResp.ok).toBe(true);
    if (setResp.ok) expect(setResp.data).toMatchObject({ role: 'vision', target: { kind: 'main' } });

    const listResp = await dispatch(
      { id: 'r15', command: 'auxiliary-routes-list', args: { agent_group_id: MINE } },
      { caller: 'host' },
    );
    expect(listResp.ok).toBe(true);
    if (listResp.ok) expect(listResp.data).toHaveLength(1);
  });

  it('rejects an unknown target kind', async () => {
    const resp = await dispatch(
      {
        id: 'r16',
        command: 'auxiliary-routes-set',
        args: { agent_group_id: MINE, role: 'vision', kind: 'wormhole' },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/--kind must be/i);
  });

  it('requires a target id for the kinds that reference one', async () => {
    const profile = await dispatch(
      {
        id: 'r17',
        command: 'auxiliary-routes-set',
        args: { agent_group_id: MINE, role: 'vision', kind: 'endpoint-profile' },
      },
      { caller: 'host' },
    );
    expect(profile.ok).toBe(false);
    if (!profile.ok) expect(profile.error.message).toMatch(/--provider-profile-id is required/i);

    const agentKind = await dispatch(
      {
        id: 'r18',
        command: 'auxiliary-routes-set',
        args: { agent_group_id: MINE, role: 'vision', kind: 'agent' },
      },
      { caller: 'host' },
    );
    expect(agentKind.ok).toBe(false);
    if (!agentKind.ok) expect(agentKind.error.message).toMatch(/--target-agent-group-id is required/i);
  });
});
