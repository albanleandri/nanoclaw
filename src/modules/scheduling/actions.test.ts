import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: '/tmp/nanoclaw-scheduling-actions-test' }));
const PINOVA_AGENT_GROUP_ID = 'ag-1778748709932-a8wsn1';
const PINOVA_CODEX_AGENT_GROUP_ID = 'b3b36ece-a953-42f9-af6c-da0f901c27d6';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

import { createAgentGroup, createSession, closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { initSessionFolder, openInboundDb } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { insertTask, listLiveTasks } from './db.js';
import { handleCancelTask, handleListTasks, handlePauseTask, handleResumeTask, handleUpdateTask } from './actions.js';
import { wakeContainer } from '../../container-runner.js';

function now(): string {
  return new Date().toISOString();
}

function makeSession(agentGroupId: string, id: string, createdAt: string): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: createdAt,
  };
}

function seedGroup(id: string, folder: string): void {
  createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: now() });
}

function seedSession(session: Session): void {
  createSession(session);
  initSessionFolder(session.agent_group_id, session.id);
}

describe('scheduling delivery actions shared owner routing', () => {
  let ownerSession: Session;
  let codexSession: Session;

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);

    seedGroup(PINOVA_AGENT_GROUP_ID, 'telegram_main');
    seedGroup(PINOVA_CODEX_AGENT_GROUP_ID, 'main-codex');

    ownerSession = makeSession(PINOVA_AGENT_GROUP_ID, 'owner-session', '2026-06-19T08:00:00.000Z');
    codexSession = makeSession(PINOVA_CODEX_AGENT_GROUP_ID, 'codex-session', '2026-06-19T09:00:00.000Z');
    seedSession(ownerSession);
    seedSession(codexSession);

    const ownerDb = openInboundDb(ownerSession.agent_group_id, ownerSession.id);
    try {
      insertTask(ownerDb, {
        id: 'task-shared-1',
        processAfter: '2026-06-20T07:30:00.000Z',
        recurrence: '0 7 * * *',
        platformId: 'telegram:pinova',
        channelType: 'telegram',
        threadId: null,
        content: JSON.stringify({ prompt: 'Shared schedule task', script: null }),
      });
    } finally {
      ownerDb.close();
    }
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('lists Claude-owned live tasks when called from the Codex group', async () => {
    const codexDb = openInboundDb(codexSession.agent_group_id, codexSession.id);
    try {
      await handleListTasks({ requestId: 'req-list-1' }, codexSession, codexDb);

      const responses = codexDb
        .prepare("SELECT kind, trigger, content FROM messages_in WHERE kind = 'system' ORDER BY seq ASC")
        .all() as Array<{ kind: string; trigger: number; content: string }>;

      expect(responses).toHaveLength(1);
      expect(responses[0].trigger).toBe(0);
      const payload = JSON.parse(responses[0].content) as {
        action: string;
        requestId: string;
        ok: boolean;
        tasks: Array<{ id: string; status: string; content: string }>;
      };
      expect(payload.action).toBe('schedule_admin_response');
      expect(payload.requestId).toBe('req-list-1');
      expect(payload.ok).toBe(true);
      expect(payload.tasks).toHaveLength(1);
      expect(payload.tasks[0].id).toBe('task-shared-1');
      expect(JSON.parse(payload.tasks[0].content)).toMatchObject({ prompt: 'Shared schedule task' });
    } finally {
      codexDb.close();
    }
  });

  it('mutates the Claude-owned task rather than the Codex session DB', async () => {
    const codexDb = openInboundDb(codexSession.agent_group_id, codexSession.id);
    try {
      await handlePauseTask({ taskId: 'task-shared-1' }, codexSession, codexDb);
      expect(listLiveTasks(codexDb, 'paused')).toEqual([]);
    } finally {
      codexDb.close();
    }

    const ownerDb = openInboundDb(ownerSession.agent_group_id, ownerSession.id);
    try {
      const paused = listLiveTasks(ownerDb, 'paused');
      expect(paused).toHaveLength(1);
      expect(paused[0].id).toBe('task-shared-1');
    } finally {
      ownerDb.close();
    }
  });

  it('updates the Claude-owned task content and timing from the Codex group', async () => {
    const codexDb = openInboundDb(codexSession.agent_group_id, codexSession.id);
    try {
      await handleUpdateTask(
        {
          taskId: 'task-shared-1',
          prompt: 'Updated shared prompt',
          script: null,
          processAfter: '2026-06-21T06:15:00.000Z',
          recurrence: null,
        },
        codexSession,
        codexDb,
      );
      expect(listLiveTasks(codexDb)).toEqual([]);
    } finally {
      codexDb.close();
    }

    const ownerDb = openInboundDb(ownerSession.agent_group_id, ownerSession.id);
    try {
      const rows = listLiveTasks(ownerDb);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 'task-shared-1',
        process_after: '2026-06-21T06:15:00.000Z',
        recurrence: null,
      });
      expect(JSON.parse(rows[0].content)).toEqual({ prompt: 'Updated shared prompt', script: null });
    } finally {
      ownerDb.close();
    }
  });

  it('resumes and cancels Claude-owned tasks from the Codex group', async () => {
    let codexDb = openInboundDb(codexSession.agent_group_id, codexSession.id);
    try {
      await handlePauseTask({ taskId: 'task-shared-1' }, codexSession, codexDb);
      await handleResumeTask({ taskId: 'task-shared-1' }, codexSession, codexDb);
      await handleCancelTask({ taskId: 'task-shared-1' }, codexSession, codexDb);
    } finally {
      codexDb.close();
    }

    codexDb = openInboundDb(codexSession.agent_group_id, codexSession.id);
    try {
      expect(listLiveTasks(codexDb)).toEqual([]);
    } finally {
      codexDb.close();
    }

    const ownerDb = openInboundDb(ownerSession.agent_group_id, ownerSession.id);
    try {
      expect(listLiveTasks(ownerDb)).toEqual([]);
      const row = ownerDb
        .prepare("SELECT status, recurrence FROM messages_in WHERE id = ? AND kind = 'task'")
        .get('task-shared-1') as { status: string; recurrence: string | null };
      expect(row).toEqual({ status: 'completed', recurrence: null });
    } finally {
      ownerDb.close();
    }
  });

  it('notifies and wakes the Codex session when update_task matches no live task', async () => {
    const codexDb = openInboundDb(codexSession.agent_group_id, codexSession.id);
    try {
      await handleUpdateTask({ taskId: 'missing-task', prompt: 'No match' }, codexSession, codexDb);

      const notice = codexDb
        .prepare("SELECT kind, content FROM messages_in WHERE kind = 'chat' ORDER BY seq ASC")
        .get() as { kind: string; content: string };
      expect(JSON.parse(notice.content)).toMatchObject({
        text: 'update_task: no live task matched id "missing-task".',
        sender: 'system',
        senderId: 'system',
      });
    } finally {
      codexDb.close();
    }

    expect(wakeContainer).toHaveBeenCalledWith(expect.objectContaining({ id: codexSession.id }));
  });
});
