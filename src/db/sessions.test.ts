import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from './agent-groups.js';
import { closeDb, initTestDb } from './connection.js';
import { createMessagingGroup } from './messaging-groups.js';
import { runMigrations } from './migrations/index.js';
import {
  createSession,
  findSessionByAgentGroup,
  findSystemSession,
  findTaskSessions,
  isTaskThread,
  taskThreadId,
} from './sessions.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: 'ag-1',
    name: 'ag-1',
    folder: 'ag-1',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'test',
    platform_id: 'mg-1',
    name: 'mg-1',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: new Date().toISOString(),
  });
});

afterEach(() => closeDb());

describe('task session helpers', () => {
  // Regression for the ncl-tasks port — findSessionByAgentGroup must never
  // resolve a system task session as the group's chat session, or agent-to-agent
  // messages route into a dead task thread (see the rollback note in
  // docs/ncl-tasks-migration.md).
  it('excludes system task sessions from findSessionByAgentGroup', () => {
    createSession({
      id: 'sess-chat',
      agent_group_id: 'ag-1',
      messaging_group_id: 'mg-1',
      thread_id: 'thread-1',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-07-01T00:00:00.000Z',
    });
    createSession({
      id: 'sess-task',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: 'system:tasks:daily-1a2b',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-07-02T00:00:00.000Z',
    });

    expect(findSessionByAgentGroup('ag-1')?.id).toBe('sess-chat');
    expect(findSystemSession('ag-1', 'system:tasks:daily-1a2b')?.id).toBe('sess-task');
    expect(findTaskSessions('ag-1').map((s) => s.id)).toEqual(['sess-task']);
  });

  it('recognises both per-series and legacy shared task threads', () => {
    expect(isTaskThread('system:tasks')).toBe(true);
    expect(isTaskThread('system:tasks:daily-1a2b')).toBe(true);
    expect(isTaskThread('thread-1')).toBe(false);
    expect(isTaskThread(null)).toBe(false);
    expect(taskThreadId('daily-1a2b')).toBe('system:tasks:daily-1a2b');
  });

  // Regression: findSessionByAgentGroup's system-session exclusion (Step 4)
  // must stay narrow to the `thread_id LIKE 'system:%'` case. Two real
  // production session shapes also have messaging_group_id: null and MUST
  // keep resolving here:
  //   1. the agent-shared session, created via
  //      resolveSession(target, null, null, 'agent-shared') in
  //      src/modules/agent-to-agent/agent-route.ts
  //   2. the per-thread job session, created via
  //      resolveSession(assignee, null, task.job.id, 'per-thread') in
  //      src/jobs/agent-task-service.ts
  // If the `thread_id IS NOT NULL` conjunct in the exclusion predicate is
  // ever dropped, shape 1 (thread_id IS NULL) starts failing this test:
  // `NULL LIKE 'system:%'` is unknown, so `NOT (... AND unknown)` is itself
  // unknown and SQLite drops the row from the WHERE clause.
  it('still resolves an agent-shared session (messaging_group_id null, thread_id null)', () => {
    createSession({
      id: 'sess-agent-shared',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-07-01T00:00:00.000Z',
    });

    expect(findSessionByAgentGroup('ag-1')?.id).toBe('sess-agent-shared');
  });

  it('still resolves a per-thread job session (messaging_group_id null, non-system thread_id)', () => {
    createSession({
      id: 'sess-per-thread',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: 'thread-1',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-07-01T00:00:00.000Z',
    });

    expect(findSessionByAgentGroup('ag-1')?.id).toBe('sess-per-thread');
  });
});
