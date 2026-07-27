/**
 * `ncl roles grant/revoke` is a privilege-granting surface and was entirely
 * uncovered. The invariants that matter are the ones that stop a role write
 * from creating a privilege it shouldn't: owner is always global, role names
 * are a closed set, and an agent caller can never reach the handler without
 * passing through admin approval first.
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
import { getDb } from '../../db/connection.js';
import { createUser } from '../../modules/permissions/db/users.js';
import type { CallerContext } from '../frame.js';
import { dispatch } from '../dispatch.js';
import './roles.js';

const GROUP = 'ag-roles';
const SESSION = 'sess-roles-1';
const HOST: CallerContext = { caller: 'host' };
const AGENT: CallerContext = {
  caller: 'agent',
  sessionId: SESSION,
  agentGroupId: GROUP,
  messagingGroupId: 'mg-1',
};

function now(): string {
  return new Date().toISOString();
}

function rolesFor(userId: string) {
  return getDb()
    .prepare('SELECT user_id, role, agent_group_id FROM user_roles WHERE user_id = ? ORDER BY role')
    .all(userId);
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: GROUP, name: GROUP, folder: GROUP, agent_provider: null, created_at: now() });
  ensureContainerConfig(GROUP);
  updateContainerConfigScalars(GROUP, { cli_scope: 'global' });
  createSession({
    id: SESSION,
    agent_group_id: GROUP,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  createUser({ id: 'u1', kind: 'telegram', display_name: 'User One', created_at: now() });
});

afterEach(() => closeDb());

describe('roles grant', () => {
  it('grants a global admin role', async () => {
    const resp = await dispatch({ id: 'g1', command: 'roles-grant', args: { user: 'u1', role: 'admin' } }, HOST);

    expect(resp.ok).toBe(true);
    expect(rolesFor('u1')).toEqual([{ user_id: 'u1', role: 'admin', agent_group_id: null }]);
  });

  it('grants an admin role scoped to one agent group', async () => {
    const resp = await dispatch(
      { id: 'g2', command: 'roles-grant', args: { user: 'u1', role: 'admin', group: GROUP } },
      HOST,
    );

    expect(resp.ok).toBe(true);
    expect(rolesFor('u1')).toEqual([{ user_id: 'u1', role: 'admin', agent_group_id: GROUP }]);
  });

  it('refuses to scope the owner role to a single group', async () => {
    // A group-scoped "owner" would be a privilege the model does not define.
    const resp = await dispatch(
      { id: 'g3', command: 'roles-grant', args: { user: 'u1', role: 'owner', group: GROUP } },
      HOST,
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/owner role is always global/i);
    expect(rolesFor('u1')).toEqual([]);
  });

  it('rejects a role outside the closed set', async () => {
    const resp = await dispatch({ id: 'g4', command: 'roles-grant', args: { user: 'u1', role: 'superuser' } }, HOST);

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/--role must be owner or admin/i);
    expect(rolesFor('u1')).toEqual([]);
  });

  it('requires a user', async () => {
    const resp = await dispatch({ id: 'g5', command: 'roles-grant', args: { role: 'admin' } }, HOST);

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/--user is required/i);
  });

  it('is idempotent — re-granting does not duplicate the row', async () => {
    for (const id of ['g6', 'g7']) {
      await dispatch({ id, command: 'roles-grant', args: { user: 'u1', role: 'admin' } }, HOST);
    }

    expect(rolesFor('u1')).toHaveLength(1);
  });
});

describe('roles revoke', () => {
  it('revokes a global role', async () => {
    await dispatch({ id: 'r1', command: 'roles-grant', args: { user: 'u1', role: 'admin' } }, HOST);

    const resp = await dispatch({ id: 'r2', command: 'roles-revoke', args: { user: 'u1', role: 'admin' } }, HOST);

    expect(resp.ok).toBe(true);
    expect(rolesFor('u1')).toEqual([]);
  });

  it('does not revoke a global role when a group is named', async () => {
    // Scope is part of the identity of the grant — revoking "admin @ group"
    // must not silently remove the global admin role.
    await dispatch({ id: 'r3', command: 'roles-grant', args: { user: 'u1', role: 'admin' } }, HOST);

    const resp = await dispatch(
      { id: 'r4', command: 'roles-revoke', args: { user: 'u1', role: 'admin', group: GROUP } },
      HOST,
    );

    expect(resp.ok).toBe(false);
    expect(rolesFor('u1')).toEqual([{ user_id: 'u1', role: 'admin', agent_group_id: null }]);
  });

  it('reports a missing grant rather than silently succeeding', async () => {
    const resp = await dispatch({ id: 'r5', command: 'roles-revoke', args: { user: 'u1', role: 'admin' } }, HOST);

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/role not found/i);
  });
});

describe('roles — agent caller', () => {
  it('cannot grant itself a role without admin approval', async () => {
    const resp = await dispatch({ id: 'a1', command: 'roles-grant', args: { user: 'u1', role: 'owner' } }, AGENT);

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('approval-pending');
    // Critically: nothing was written while the approval is outstanding.
    expect(rolesFor('u1')).toEqual([]);
  });

  it('cannot revoke a role without admin approval', async () => {
    await dispatch({ id: 'a2', command: 'roles-grant', args: { user: 'u1', role: 'admin' } }, HOST);

    const resp = await dispatch({ id: 'a3', command: 'roles-revoke', args: { user: 'u1', role: 'admin' } }, AGENT);

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('approval-pending');
    expect(rolesFor('u1')).toHaveLength(1);
  });
});
