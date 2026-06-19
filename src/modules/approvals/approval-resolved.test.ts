/**
 * Approval-resolved callback registry.
 *
 * Drives the real response-handler entry (`handleApprovalsResponse`) and
 * asserts that callbacks registered via `registerApprovalResolvedHandler`
 * fire when an admin resolves a pending approval — the hook modules use to
 * observe approval resolution (e.g. clearing an "awaiting approval" status
 * indicator). Goes red if the response handler stops calling
 * `notifyApprovalResolved`.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, createPendingApproval, getPendingApproval } from '../../db/sessions.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { initSessionFolder, openInboundDb } from '../../session-manager.js';
import { wakeContainer } from '../../container-runner.js';
import { handleApprovalsResponse } from './response-handler.js';
import { registerApprovalHandler, registerApprovalResolvedHandler, type ApprovalResolvedEvent } from './primitive.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-approval-resolved' };
});

const TEST_DIR = '/tmp/nanoclaw-test-approval-resolved';

function now() {
  return new Date().toISOString();
}

function seedApproval(approvalId: string, action: string): void {
  createPendingApproval({
    approval_id: approvalId,
    session_id: 'sess-1',
    request_id: approvalId,
    action,
    payload: JSON.stringify({}),
    created_at: now(),
    title: 'Test approval',
    options_json: JSON.stringify([]),
  });
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
  initSessionFolder('ag-1', 'sess-1');

  // Resolution only happens for authorized clicks — seed the clicking admin.
  upsertUser({ id: 'slack:admin-1', kind: 'slack', display_name: 'Admin', created_at: now() });
  grantRole({ user_id: 'slack:admin-1', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('approval-resolved callbacks', () => {
  it('fires registered callbacks on reject with the approval, session, and outcome', async () => {
    const events: ApprovalResolvedEvent[] = [];
    registerApprovalResolvedHandler((event) => {
      events.push(event);
    });

    seedApproval('appr-reject-1', 'test_reject_action');
    const claimed = await handleApprovalsResponse({
      questionId: 'appr-reject-1',
      value: 'reject',
      userId: 'slack:admin-1',
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
    });

    expect(claimed).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('reject');
    expect(events[0].approval.approval_id).toBe('appr-reject-1');
    expect(events[0].approval.action).toBe('test_reject_action');
    expect(events[0].session.id).toBe('sess-1');
    expect(events[0].userId).toBe('slack:admin-1');
  });

  it('fires registered callbacks on approve after the action handler ran', async () => {
    const calls: string[] = [];
    registerApprovalHandler('test_approve_action', async () => {
      calls.push('handler');
    });
    registerApprovalResolvedHandler(({ outcome }) => {
      calls.push(`resolved:${outcome}`);
    });

    seedApproval('appr-approve-1', 'test_approve_action');
    await handleApprovalsResponse({
      questionId: 'appr-approve-1',
      value: 'approve',
      userId: 'slack:admin-1',
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
    });

    expect(calls).toEqual(['handler', 'resolved:approve']);
  });

  it('isolates a throwing callback so later callbacks still fire', async () => {
    const events: string[] = [];
    registerApprovalResolvedHandler(() => {
      events.push('boom');
      throw new Error('callback exploded');
    });
    registerApprovalResolvedHandler(() => {
      events.push('after');
    });

    seedApproval('appr-reject-2', 'test_isolation_action');
    const claimed = await handleApprovalsResponse({
      questionId: 'appr-reject-2',
      value: 'reject',
      userId: 'slack:admin-1',
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
    });

    expect(claimed).toBe(true);
    expect(events).toEqual(['boom', 'after']);
  });

  it('notifies the agent and drops the row when an approved action has no registered handler', async () => {
    seedApproval('appr-no-handler-1', 'test_no_handler_action');

    const claimed = await handleApprovalsResponse({
      questionId: 'appr-no-handler-1',
      value: 'approve',
      userId: 'slack:admin-1',
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
    });

    expect(claimed).toBe(true);
    expect(getPendingApproval('appr-no-handler-1')).toBeUndefined();
    expect(wakeContainer).toHaveBeenCalledWith(expect.objectContaining({ id: 'sess-1' }));

    const sessionDb = openInboundDb('ag-1', 'sess-1');
    try {
      const notice = sessionDb
        .prepare("SELECT content FROM messages_in WHERE kind = 'chat' ORDER BY seq ASC")
        .get() as { content: string };
      expect(JSON.parse(notice.content)).toMatchObject({
        text: 'Your test_no_handler_action was approved, but no handler is installed to apply it.',
        sender: 'system',
        senderId: 'system',
      });
    } finally {
      sessionDb.close();
    }
  });

  it('notifies the agent, drops the row, and wakes the session when an approval handler throws', async () => {
    registerApprovalHandler('test_throwing_action', async () => {
      throw new Error('apply failed');
    });
    seedApproval('appr-throw-1', 'test_throwing_action');

    const claimed = await handleApprovalsResponse({
      questionId: 'appr-throw-1',
      value: 'approve',
      userId: 'slack:admin-1',
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
    });

    expect(claimed).toBe(true);
    expect(getPendingApproval('appr-throw-1')).toBeUndefined();
    expect(wakeContainer).toHaveBeenCalledWith(expect.objectContaining({ id: 'sess-1' }));

    const sessionDb = openInboundDb('ag-1', 'sess-1');
    try {
      const notice = sessionDb
        .prepare("SELECT content FROM messages_in WHERE kind = 'chat' ORDER BY seq ASC")
        .get() as { content: string };
      expect(JSON.parse(notice.content)).toMatchObject({
        text: 'Your test_throwing_action was approved, but applying it failed: apply failed.',
        sender: 'system',
        senderId: 'system',
      });
    } finally {
      sessionDb.close();
    }
  });
});
