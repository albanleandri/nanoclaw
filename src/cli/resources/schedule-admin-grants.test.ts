/**
 * Schedule admin grants let one agent group administer another group's
 * recurring tasks — a cross-tenant privilege, and previously uncovered.
 *
 * Two layers guard it and both are exercised here: dispatch's CLI-scope
 * whitelist (a group-scoped agent cannot reach the resource at all) and the
 * resource's own `requireGlobal` (defence in depth if the whitelist changes).
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
import { listScheduleAdminGrants } from '../../db/schedule-admin-grants.js';
import type { CallerContext } from '../frame.js';
import { dispatch } from '../dispatch.js';
import './schedule-admin-grants.js';

const ADMIN_GROUP = 'ag-scheduler';
const OWNER_GROUP = 'ag-owner';
const SESSION = 'sess-sag-1';
const HOST: CallerContext = { caller: 'host' };

function now(): string {
  return new Date().toISOString();
}

function agentCtx(): CallerContext {
  return { caller: 'agent', sessionId: SESSION, agentGroupId: ADMIN_GROUP, messagingGroupId: 'mg-1' };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  for (const id of [ADMIN_GROUP, OWNER_GROUP]) {
    createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
    ensureContainerConfig(id);
  }
  createSession({
    id: SESSION,
    agent_group_id: ADMIN_GROUP,
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

describe('schedule-admin-grants — host caller', () => {
  it('grants and lists a cross-group schedule admin relationship', async () => {
    const grant = await dispatch(
      {
        id: 's1',
        command: 'schedule-admin-grants-grant',
        args: { 'admin-agent-group-id': ADMIN_GROUP, 'owner-agent-group-id': OWNER_GROUP },
      },
      HOST,
    );
    expect(grant.ok).toBe(true);

    const list = await dispatch({ id: 's2', command: 'schedule-admin-grants-list', args: {} }, HOST);
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.data).toEqual([
        expect.objectContaining({
          admin_agent_group_id: ADMIN_GROUP,
          owner_agent_group_id: OWNER_GROUP,
        }),
      ]);
    }
  });

  it('accepts the snake_case argument spelling as well as the flag spelling', async () => {
    const resp = await dispatch(
      {
        id: 's3',
        command: 'schedule-admin-grants-grant',
        args: { admin_agent_group_id: ADMIN_GROUP, owner_agent_group_id: OWNER_GROUP },
      },
      HOST,
    );

    expect(resp.ok).toBe(true);
    expect(listScheduleAdminGrants()).toHaveLength(1);
  });

  it('requires both sides of the grant', async () => {
    const resp = await dispatch(
      { id: 's4', command: 'schedule-admin-grants-grant', args: { 'admin-agent-group-id': ADMIN_GROUP } },
      HOST,
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/are required/i);
    expect(listScheduleAdminGrants()).toEqual([]);
  });

  it('revokes an existing grant', async () => {
    await dispatch(
      {
        id: 's5',
        command: 'schedule-admin-grants-grant',
        args: { 'admin-agent-group-id': ADMIN_GROUP, 'owner-agent-group-id': OWNER_GROUP },
      },
      HOST,
    );

    const resp = await dispatch(
      {
        id: 's6',
        command: 'schedule-admin-grants-revoke',
        args: { 'admin-agent-group-id': ADMIN_GROUP, 'owner-agent-group-id': OWNER_GROUP },
      },
      HOST,
    );

    expect(resp.ok).toBe(true);
    expect(listScheduleAdminGrants()).toEqual([]);
  });
});

describe('schedule-admin-grants — agent caller', () => {
  it('is unreachable from a group-scoped agent', async () => {
    updateContainerConfigScalars(ADMIN_GROUP, { cli_scope: 'group' });

    const resp = await dispatch({ id: 's7', command: 'schedule-admin-grants-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toMatch(/scoped to this agent group/i);
    }
  });

  it('is unreachable when CLI access is disabled entirely', async () => {
    updateContainerConfigScalars(ADMIN_GROUP, { cli_scope: 'disabled' });

    const resp = await dispatch({ id: 's8', command: 'schedule-admin-grants-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/CLI access is disabled/i);
  });

  it('can list once granted global CLI scope', async () => {
    updateContainerConfigScalars(ADMIN_GROUP, { cli_scope: 'global' });

    const resp = await dispatch({ id: 's9', command: 'schedule-admin-grants-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('still cannot grant itself schedule admin without approval', async () => {
    updateContainerConfigScalars(ADMIN_GROUP, { cli_scope: 'global' });

    const resp = await dispatch(
      {
        id: 's10',
        command: 'schedule-admin-grants-grant',
        args: { 'admin-agent-group-id': ADMIN_GROUP, 'owner-agent-group-id': OWNER_GROUP },
      },
      agentCtx(),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('approval-pending');
    expect(listScheduleAdminGrants()).toEqual([]);
  });
});
