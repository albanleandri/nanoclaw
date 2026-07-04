import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDeliveryAction } from '../delivery.js';
import {
  closeDb,
  createAgentGroup,
  createAgentTask,
  createSession,
  getAgentTask,
  getJobEvents,
  initTestDb,
  runMigrations,
  setAgentTaskAssigneeSession,
  transitionAgentTask,
} from '../db/index.js';
import { inboundDbPath, initSessionFolder, openInboundDb } from '../session-manager.js';
import type { Session } from '../types.js';
import './agent-task-actions.js';

vi.mock('../container-runner.js', () => ({ wakeContainer: vi.fn().mockResolvedValue(true) }));
vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-agent-task-actions' };
});

const TEST_DIR = '/tmp/nanoclaw-agent-task-actions';
const now = () => new Date().toISOString();
const sessions: Record<string, Session> = {};

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  const db = initTestDb();
  runMigrations(db);
  for (const id of ['requester', 'assignee', 'other']) {
    createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
    sessions[id] = {
      id: `sess-${id}`,
      agent_group_id: id,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    };
    createSession(sessions[id]);
    initSessionFolder(id, sessions[id].id);
  }
  createAgentTask(
    {
      taskId: 'task-1',
      requesterAgentGroupId: 'requester',
      assigneeAgentGroupId: 'assignee',
      goal: 'Review',
      requiredCapabilities: [],
      artifactPolicy: 'files',
      scope: 'agent-delegation',
    },
    sessions.requester.id,
  );
  setAgentTaskAssigneeSession('task-1', sessions.assignee.id);
  transitionAgentTask('task-1', ['queued'], 'running');
});
afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

async function invoke(action: string, content: Record<string, unknown>, actor: Session): Promise<void> {
  const handler = getDeliveryAction(action)!;
  const db = openInboundDb(actor.agent_group_id, actor.id);
  try {
    await handler({ action, actionId: `${action}-1`, taskId: 'task-1', ...content }, actor, db);
  } finally {
    db.close();
  }
}

describe('agent task host actions', () => {
  it('allows only the assignee to report progress and delivers one correlated requester event', async () => {
    await expect(invoke('report_agent_task_progress', { message: 'halfway' }, sessions.other)).rejects.toThrow(
      /unauthorized/,
    );
    await invoke('report_agent_task_progress', { message: 'halfway' }, sessions.assignee);
    await invoke('report_agent_task_progress', { message: 'halfway' }, sessions.assignee);
    expect(getJobEvents('task-1').map((event) => event.event_type)).toEqual(['progress']);
    const db = new Database(inboundDbPath('requester', sessions.requester.id), { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE kind='agent-task-event'").get()).toEqual({ n: 1 });
    db.close();
  });

  it('allows only the requester to query task status', async () => {
    await expect(invoke('get_agent_task', {}, sessions.assignee)).rejects.toThrow(/Only the task requester/);
    await invoke('get_agent_task', {}, sessions.requester);
    expect(getJobEvents('task-1').map((event) => event.event_type)).toEqual(['progress']);
  });

  it('makes completion monotonic and rejects late cancellation', async () => {
    await invoke('complete_agent_task', { result: { summary: 'done' } }, sessions.assignee);
    expect(getAgentTask('task-1')?.job.status).toBe('succeeded');
    await expect(invoke('cancel_agent_task', {}, sessions.requester)).rejects.toThrow(/terminal/);
    await expect(invoke('report_agent_task_progress', { message: 'late' }, sessions.assignee)).rejects.toThrow(
      /terminal/,
    );
  });

  it('re-delivers the terminal event on retry when a prior delivery was lost', async () => {
    await invoke('complete_agent_task', { result: { summary: 'done' } }, sessions.assignee);

    // Simulate a crash around delivery: the terminal event is committed but
    // the requester's inbound copy is gone. A redelivery of the same outbound
    // action must re-deliver it rather than silently returning.
    const wdb = new Database(inboundDbPath('requester', sessions.requester.id));
    wdb.prepare("DELETE FROM messages_in WHERE kind='agent-task-event'").run();
    wdb.close();

    await invoke('complete_agent_task', { result: { summary: 'done' } }, sessions.assignee);

    expect(getAgentTask('task-1')?.job.status).toBe('succeeded');
    expect(getJobEvents('task-1').filter((e) => e.event_type === 'completed')).toHaveLength(1);
    const rdb = new Database(inboundDbPath('requester', sessions.requester.id), { readonly: true });
    expect(rdb.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE kind='agent-task-event'").get()).toEqual({ n: 1 });
    rdb.close();
  });

  it('cancels once, notifies the assignee, and cannot be revived', async () => {
    await invoke('cancel_agent_task', {}, sessions.requester);
    await invoke('cancel_agent_task', {}, sessions.requester);
    expect(getAgentTask('task-1')?.job.status).toBe('cancelled');
    const db = new Database(inboundDbPath('assignee', sessions.assignee.id), { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE kind='agent-task-cancel'").get()).toEqual({ n: 1 });
    db.close();
    await expect(invoke('complete_agent_task', { result: 'late' }, sessions.assignee)).rejects.toThrow(/terminal/);
  });

  it('forwards artifact bytes through safe outbox/inbox paths and stores metadata only', async () => {
    const actionId = 'publish_agent_task_artifact-1';
    const outbox = path.join(TEST_DIR, 'v2-sessions', 'assignee', sessions.assignee.id, 'outbox', actionId);
    fs.mkdirSync(outbox, { recursive: true });
    fs.writeFileSync(path.join(outbox, 'report.md'), 'report');
    await invoke('publish_agent_task_artifact', { filename: 'report.md' }, sessions.assignee);
    const event = getJobEvents('task-1')[0];
    expect(event.event_type).toBe('artifact');
    expect(event.data).toMatchObject({ filename: 'report.md', size: 6 });
    expect(JSON.stringify(event.data)).not.toContain(TEST_DIR);
    expect(
      fs.existsSync(
        path.join(
          TEST_DIR,
          'v2-sessions',
          'requester',
          sessions.requester.id,
          'inbox',
          `agent-task-artifact:task-1:${actionId}`,
          'report.md',
        ),
      ),
    ).toBe(true);
    expect(fs.existsSync(outbox)).toBe(false);
  });
});
