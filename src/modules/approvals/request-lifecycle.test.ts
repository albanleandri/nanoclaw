import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, getPendingApprovalsByAction, getSession } from '../../db/sessions.js';
import { clearDeliveryAdapterForTesting, setDeliveryAdapter } from '../../delivery.js';
import { initSessionFolder } from '../../session-manager.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';

const TEST_DIR = '/tmp/nanoclaw-test-approval-request-lifecycle';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../permissions/user-dm.js', () => ({
  ensureUserDm: vi.fn().mockResolvedValue({
    id: 'mg-admin',
    channel_type: 'telegram',
    platform_id: 'admin-dm',
    name: 'Admin',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: '2026-01-01T00:00:00.000Z',
  }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-approval-request-lifecycle' };
});

import { requestApproval } from './primitive.js';

function now(): string {
  return new Date().toISOString();
}

describe('approval request lifecycle', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
    createSession({
      id: 'sess-1',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: now(),
      created_at: now(),
    });
    initSessionFolder('ag-1', 'sess-1');
    upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
    grantRole({ user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  });

  afterEach(() => {
    clearDeliveryAdapterForTesting();
    closeDb();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('deletes the pending row when card delivery fails', async () => {
    setDeliveryAdapter({
      async deliver() {
        throw new Error('platform unavailable');
      },
    });

    await requestApproval({
      session: createSessionResult(),
      agentName: 'Agent',
      action: 'test_delivery_failure',
      payload: {},
      title: 'Test',
      question: 'Proceed?',
    });

    expect(getPendingApprovalsByAction('test_delivery_failure')).toEqual([]);
  });

  it('does not create a pending row when no delivery adapter exists', async () => {
    clearDeliveryAdapterForTesting();

    await requestApproval({
      session: createSessionResult(),
      agentName: 'Agent',
      action: 'test_missing_adapter',
      payload: {},
      title: 'Test',
      question: 'Proceed?',
    });

    expect(getPendingApprovalsByAction('test_missing_adapter')).toEqual([]);
  });
});

function createSessionResult() {
  return getSession('sess-1')!;
}
