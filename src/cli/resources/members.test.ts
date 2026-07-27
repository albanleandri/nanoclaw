/**
 * `ncl members add/remove` grants an unprivileged user permission to interact
 * with an agent group — the check the router performs when sender_scope is
 * "known". It was entirely uncovered.
 *
 * `members` is one of the four resources an agent may touch in group CLI
 * scope, so the group-pinning behaviour (dispatch auto-fills --group with the
 * caller's own id, and refuses a foreign one) is the load-bearing part here.
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
import { ensureContainerConfig } from '../../db/container-configs.js';
import { getDb } from '../../db/connection.js';
import { createUser } from '../../modules/permissions/db/users.js';
import type { CallerContext } from '../frame.js';
import { dispatch } from '../dispatch.js';
import './members.js';

const MINE = 'ag-members-mine';
const THEIRS = 'ag-members-theirs';
const SESSION = 'sess-members-1';
const HOST: CallerContext = { caller: 'host' };
const AGENT: CallerContext = {
  caller: 'agent',
  sessionId: SESSION,
  agentGroupId: MINE,
  messagingGroupId: 'mg-1',
};

function now(): string {
  return new Date().toISOString();
}

function members() {
  return getDb()
    .prepare('SELECT user_id, agent_group_id FROM agent_group_members ORDER BY agent_group_id, user_id')
    .all();
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  for (const id of [MINE, THEIRS]) {
    createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
    ensureContainerConfig(id);
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
  for (const u of ['u1', 'u2']) {
    createUser({ id: u, kind: 'telegram', display_name: u, created_at: now() });
  }
});

afterEach(() => closeDb());

describe('members add', () => {
  it('adds a member to an agent group', async () => {
    const resp = await dispatch({ id: 'm1', command: 'members-add', args: { user: 'u1', group: MINE } }, HOST);

    expect(resp.ok).toBe(true);
    expect(members()).toEqual([{ user_id: 'u1', agent_group_id: MINE }]);
  });

  it('requires both a user and a group', async () => {
    const noUser = await dispatch({ id: 'm2', command: 'members-add', args: { group: MINE } }, HOST);
    expect(noUser.ok).toBe(false);
    if (!noUser.ok) expect(noUser.error.message).toMatch(/--user is required/i);

    const noGroup = await dispatch({ id: 'm3', command: 'members-add', args: { user: 'u1' } }, HOST);
    expect(noGroup.ok).toBe(false);
    if (!noGroup.ok) expect(noGroup.error.message).toMatch(/--group is required/i);

    expect(members()).toEqual([]);
  });

  it('is idempotent — re-adding does not duplicate membership', async () => {
    for (const id of ['m4', 'm5']) {
      await dispatch({ id, command: 'members-add', args: { user: 'u1', group: MINE } }, HOST);
    }

    expect(members()).toHaveLength(1);
  });
});

describe('members remove', () => {
  it('removes an existing membership', async () => {
    await dispatch({ id: 'm6', command: 'members-add', args: { user: 'u1', group: MINE } }, HOST);

    const resp = await dispatch({ id: 'm7', command: 'members-remove', args: { user: 'u1', group: MINE } }, HOST);

    expect(resp.ok).toBe(true);
    expect(members()).toEqual([]);
  });

  it('reports a missing membership rather than silently succeeding', async () => {
    const resp = await dispatch({ id: 'm8', command: 'members-remove', args: { user: 'u1', group: MINE } }, HOST);

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/member not found/i);
  });

  it('removing from one group leaves membership in another intact', async () => {
    await dispatch({ id: 'm9', command: 'members-add', args: { user: 'u1', group: MINE } }, HOST);
    await dispatch({ id: 'm10', command: 'members-add', args: { user: 'u1', group: THEIRS } }, HOST);

    await dispatch({ id: 'm11', command: 'members-remove', args: { user: 'u1', group: MINE } }, HOST);

    expect(members()).toEqual([{ user_id: 'u1', agent_group_id: THEIRS }]);
  });
});

describe('members — agent caller in group scope', () => {
  it('refuses to add a member to another agent group', async () => {
    const resp = await dispatch({ id: 'm12', command: 'members-add', args: { user: 'u1', group: THEIRS } }, AGENT);

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('forbidden');
    expect(members()).toEqual([]);
  });

  it('cannot add a member to its own group without admin approval', async () => {
    const resp = await dispatch({ id: 'm13', command: 'members-add', args: { user: 'u1', group: MINE } }, AGENT);

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('approval-pending');
    expect(members()).toEqual([]);
  });

  it('lists only its own group members, not another group’s', async () => {
    await dispatch({ id: 'm14', command: 'members-add', args: { user: 'u1', group: MINE } }, HOST);
    await dispatch({ id: 'm15', command: 'members-add', args: { user: 'u2', group: THEIRS } }, HOST);

    const resp = await dispatch({ id: 'm16', command: 'members-list', args: {} }, AGENT);

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const rows = resp.data as Array<{ user_id: string; agent_group_id: string }>;
      expect(rows.map((r) => r.agent_group_id)).toEqual([MINE]);
      expect(rows.map((r) => r.user_id)).toEqual(['u1']);
    }
  });
});
