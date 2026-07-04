/**
 * Regression coverage for approval response authorization.
 *
 * Approval callback payloads are untrusted. A valid questionId is not enough;
 * the responding user must be an owner/admin for the pending approval.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createPendingApproval, createSession, getPendingApproval } from '../../db/sessions.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-approval-response-authz' };
});

const TEST_DIR = '/tmp/nanoclaw-test-approval-response-authz';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
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
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('approval response authorization', () => {
  it('claims an approval before awaiting its handler so concurrent clicks apply once', async () => {
    upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
    grantRole({ user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });

    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    let releaseHandler!: () => void;
    const handlerBlocked = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const handler = vi.fn(() => handlerBlocked);
    registerApprovalHandler('concurrent_approval_action', handler);

    createPendingApproval({
      approval_id: 'appr-concurrent',
      session_id: 'sess-1',
      request_id: 'appr-concurrent',
      action: 'concurrent_approval_action',
      payload: JSON.stringify({}),
      created_at: now(),
      title: 'Concurrent approval',
      options_json: JSON.stringify([]),
    });
    const response = {
      questionId: 'appr-concurrent',
      value: 'approve',
      userId: 'owner',
      channelType: 'telegram',
      platformId: 'dm-owner',
      threadId: null,
    };

    const first = handleApprovalsResponse(response);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await expect(handleApprovalsResponse(response)).resolves.toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);

    releaseHandler();
    await expect(first).resolves.toBe(true);
  });

  it('ignores a valid approval id clicked by a non-admin user', async () => {
    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('install_packages_authz_denied', handler);

    createPendingApproval({
      approval_id: 'appr-1',
      session_id: 'sess-1',
      request_id: 'appr-1',
      action: 'install_packages_authz_denied',
      payload: JSON.stringify({ packages: ['left-pad'] }),
      created_at: now(),
      title: 'Install packages',
      options_json: JSON.stringify([]),
    });

    const claimed = await handleApprovalsResponse({
      questionId: 'appr-1',
      value: 'approve',
      userId: 'stranger',
      channelType: 'telegram',
      platformId: 'dm-stranger',
      threadId: null,
    });

    expect(claimed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(getPendingApproval('appr-1')).toBeDefined();
  });

  it('allows an owner click to dispatch the registered approval handler', async () => {
    upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
    grantRole({ user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });

    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('install_packages_authz_allowed', handler);

    createPendingApproval({
      approval_id: 'appr-2',
      session_id: 'sess-1',
      request_id: 'appr-2',
      action: 'install_packages_authz_allowed',
      payload: JSON.stringify({ packages: ['left-pad'] }),
      created_at: now(),
      title: 'Install packages',
      options_json: JSON.stringify([]),
    });

    const claimed = await handleApprovalsResponse({
      questionId: 'appr-2',
      value: 'approve',
      userId: 'owner',
      channelType: 'telegram',
      platformId: 'dm-owner',
      threadId: null,
    });

    expect(claimed).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ userId: 'telegram:owner' }));
    expect(getPendingApproval('appr-2')).toBeUndefined();
  });

  it('allows global admins to resolve approvals without a session-scoped agent group', async () => {
    upsertUser({ id: 'telegram:global-admin', kind: 'telegram', display_name: 'Global Admin', created_at: now() });
    grantRole({
      user_id: 'telegram:global-admin',
      role: 'admin',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });

    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('global_admin_authz_allowed', handler);

    createPendingApproval({
      approval_id: 'appr-3',
      session_id: 'sess-1',
      agent_group_id: null,
      request_id: 'appr-3',
      action: 'global_admin_authz_allowed',
      payload: JSON.stringify({ packages: ['left-pad'] }),
      created_at: now(),
      title: 'Install packages',
      options_json: JSON.stringify([]),
    });

    const claimed = await handleApprovalsResponse({
      questionId: 'appr-3',
      value: 'approve',
      userId: 'global-admin',
      channelType: 'telegram',
      platformId: 'dm-global-admin',
      threadId: null,
    });

    expect(claimed).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getPendingApproval('appr-3')).toBeUndefined();
  });
});
