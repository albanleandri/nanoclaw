import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentTaskEnvelope } from '../jobs/agent-task-envelope.js';
import {
  appendAgentTaskEvent,
  createAgentTask,
  getAgentTask,
  listAgentTasksForActor,
  setAgentTaskAssigneeSession,
  transitionAgentTask,
} from './agent-tasks.js';
import { closeDb, createAgentGroup, createSession, getDb, getJobEvents, initTestDb, runMigrations } from './index.js';

const now = () => new Date().toISOString();
const envelope: AgentTaskEnvelope = {
  taskId: 'task-1',
  requesterAgentGroupId: 'requester',
  assigneeAgentGroupId: 'assignee',
  goal: 'Review the code',
  requiredCapabilities: [],
  artifactPolicy: 'files',
  scope: 'agent-delegation',
};

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  for (const id of ['requester', 'assignee', 'other']) {
    createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
    createSession({
      id: `sess-${id}`,
      agent_group_id: id,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
  }
});
afterEach(closeDb);

describe('agent task persistence', () => {
  it('creates the job and ownership relation atomically and idempotently', () => {
    const first = createAgentTask(envelope, 'sess-requester');
    const second = createAgentTask(envelope, 'sess-requester');
    expect(second).toEqual(first);
    expect(first.job.type).toBe('agent_task');
    expect(first.task.dispatch_message_id).toBe('agent-task:task-1');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 1 });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_tasks').get()).toEqual({ n: 1 });
  });

  it('rejects task-id reuse by a different envelope or requester', () => {
    createAgentTask(envelope, 'sess-requester');
    expect(() => createAgentTask({ ...envelope, goal: 'Different' }, 'sess-requester')).toThrow(/conflict/);
    expect(() => createAgentTask({ ...envelope, requesterAgentGroupId: 'other' }, 'sess-other')).toThrow(/conflict/);
  });

  it('scopes lookup/listing to requester or assignee and records target session', () => {
    createAgentTask(envelope, 'sess-requester');
    setAgentTaskAssigneeSession('task-1', 'sess-assignee');
    expect(getAgentTask('task-1', 'requester')?.task.assignee_session_id).toBe('sess-assignee');
    expect(getAgentTask('task-1', 'assignee')).toBeDefined();
    expect(getAgentTask('task-1', 'other')).toBeUndefined();
    expect(listAgentTasksForActor('requester')).toHaveLength(1);
    expect(listAgentTasksForActor('assignee')).toHaveLength(1);
    expect(listAgentTasksForActor('other')).toHaveLength(0);
  });

  it('appends idempotent monotonic events and compare-and-sets terminal state', () => {
    createAgentTask(envelope, 'sess-requester');
    const accepted = appendAgentTaskEvent('task-1', 'action-1', {
      type: 'accepted',
      message: 'accepted',
    });
    expect(appendAgentTaskEvent('task-1', 'action-1', { type: 'accepted', message: 'accepted' })).toEqual(accepted);
    const started = appendAgentTaskEvent('task-1', 'action-2', { type: 'started' });
    expect([accepted.seq, started.seq]).toEqual([1, 2]);
    expect(transitionAgentTask('task-1', ['queued'], 'running')).toBe(true);
    expect(transitionAgentTask('task-1', ['running'], 'succeeded', { summary: 'done' })).toBe(true);
    expect(transitionAgentTask('task-1', ['queued', 'running'], 'cancelled')).toBe(false);
    expect(getJobEvents('task-1')).toHaveLength(2);
  });
});
