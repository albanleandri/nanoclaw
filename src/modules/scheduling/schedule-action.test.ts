/**
 * D4 — the host half of the surviving `schedule_task` protocol shim.
 *
 * This action is the only task write path `openai-protocol-loop` providers have
 * (and, because the compiled capability plan grants nanoclaw.schedule-task to
 * every group, one that Claude and Codex agents can reach too). If the
 * registration ever stops running at startup, delivery logs "Unknown system
 * action" and silently drops every task scheduled through it — no other test
 * would notice, which is why the registration itself is asserted here.
 *
 * That assertion is only worth anything if it reaches the registration the way
 * the host does, through the modules barrel — see the import note below.
 */
import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: '/tmp/nanoclaw-schedule-action-test' }));
const CALLER_AGENT_GROUP_ID = 'ag-caller-test';
const OWNER_AGENT_GROUP_ID = 'ag-owner-test';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

import {
  createAgentGroup,
  createSession,
  closeDb,
  grantScheduleAdmin,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { findTaskSessions } from '../../db/sessions.js';
import { getDeliveryAction } from '../../delivery.js';
import { resolveTaskSession, withInboundDb } from '../../session-manager.js';
import type { Session } from '../../types.js';
// The modules BARREL, deliberately — not './schedule-action.js'. Importing the
// module directly would register the handler itself and make the registration
// assertion below unfalsifiable: it would stay green even with the barrel line
// deleted, which is precisely the regression this file claims to catch. Going
// through '../index.js' exercises the same chain src/index.ts boots
// (src/index.ts → modules/index.js → ./scheduling/schedule-action.js).
import '../index.js';

interface TaskRow {
  id: string;
  series_id: string | null;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  content: string;
}

function makeSession(agentGroupId: string, id: string): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

function seedGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
}

/** Read the live task rows out of the per-series session the handler resolved. */
function tasksInSeriesSession(agentGroupId: string, seriesId: string): TaskRow[] {
  const { session, created } = resolveTaskSession(agentGroupId, seriesId);
  // resolveTaskSession is find-or-create: a `created: true` here means the
  // handler never made the session, so there is nothing to read.
  expect(created).toBe(false);
  return withInboundDb(agentGroupId, session.id, (db) =>
    db
      .prepare("SELECT id, series_id, status, process_after, recurrence, content FROM messages_in WHERE kind = 'task'")
      .all(),
  ) as TaskRow[];
}

async function fire(content: Record<string, unknown>, session: Session): Promise<void> {
  const handler = getDeliveryAction('schedule_task');
  expect(handler).toBeDefined();
  // inDb is unused by this handler — it writes to the per-series session it
  // resolves, never to the caller's own inbound.db.
  await handler!(content, session, null as never);
}

describe('schedule_task delivery action (D4 protocol shim)', () => {
  let callerSession: Session;

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);

    seedGroup(CALLER_AGENT_GROUP_ID);
    seedGroup(OWNER_AGENT_GROUP_ID);

    callerSession = makeSession(CALLER_AGENT_GROUP_ID, 'caller-session');
    createSession(callerSession);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // Deleting `import './scheduling/schedule-action.js'` from src/modules/index.ts
  // must turn this red. Verified by doing exactly that.
  it('is registered through the modules barrel the host boots', () => {
    expect(getDeliveryAction('schedule_task')).toBeDefined();
  });

  it('inserts the task into the isolated per-series session of the caller own group', async () => {
    await fire(
      {
        action: 'schedule_task',
        seriesId: 't-abc123',
        prompt: 'say hi',
        script: null,
        processAfter: '2099-01-01T00:00:00.000Z',
        recurrence: '0 9 * * 1-5',
      },
      callerSession,
    );

    const rows = tasksInSeriesSession(CALLER_AGENT_GROUP_ID, 't-abc123');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 't-abc123',
      series_id: 't-abc123',
      status: 'pending',
      process_after: '2099-01-01T00:00:00.000Z',
      recurrence: '0 9 * * 1-5',
    });
    // Exactly two content fields, and the prompt opens with what the agent
    // asked for — the delivery contract appended after it is pinned separately.
    const content = JSON.parse(rows[0].content) as Record<string, unknown>;
    expect(Object.keys(content).sort()).toEqual(['prompt', 'script']);
    expect(content.script).toBeNull();
    expect((content.prompt as string).startsWith('say hi\n\n[Task delivery contract:')).toBe(true);
  });

  /*
   * A shim-created task fires into an isolated `system:tasks:<id>` session, and
   * D3/one-door delivery means NOTHING leaves that session except a send_message
   * call with an explicit destination — final text and <message> blocks are
   * inert there. `ncl tasks create` teaches the agent that by baking the
   * delivery contract into the stored prompt; the shim MUST do the same, or an
   * openai-protocol-loop agent (which has no `ncl` to learn it from) schedules a
   * reminder that fires, produces text, and delivers it to nobody. Silent
   * non-delivery is exactly the failure D3 was written to prevent, so this is
   * pinned rather than left to the two call sites to remember.
   */
  it('bakes the task delivery contract into the stored prompt', async () => {
    await fire(
      {
        action: 'schedule_task',
        seriesId: 't-contract',
        prompt: 'remind me to call Dana',
        processAfter: '2099-01-01T00:00:00.000Z',
      },
      callerSession,
    );

    const [row] = tasksInSeriesSession(CALLER_AGENT_GROUP_ID, 't-contract');
    const stored = JSON.parse(row.content).prompt as string;

    expect(stored.startsWith('remind me to call Dana')).toBe(true);
    // The one door out of a task fire, and the fact that it needs naming a destination.
    expect(stored).toContain('send_message');
    expect(stored).toContain('explicit destination');
    expect(stored).toContain('no chat attached');
    // Its own run log, addressed by series id.
    expect(stored).toContain('tasks/t-contract.md');
  });

  // The deleted actions.ts let the container name any group it held a grant for
  // via `ownerAgentGroupId`. That parameter is gone: a sole grant still routes
  // to the owner (the fork's long-standing default), but the request cannot
  // choose. Cross-group scheduling is `ncl tasks --group` now.
  it('routes to the sole schedule-admin grant owner and ignores a requested group', async () => {
    grantScheduleAdmin(CALLER_AGENT_GROUP_ID, OWNER_AGENT_GROUP_ID, 'test');

    await fire(
      {
        action: 'schedule_task',
        seriesId: 't-owned1',
        ownerAgentGroupId: 'ag-somewhere-else',
        prompt: 'owner task',
        processAfter: '2099-01-01T00:00:00.000Z',
      },
      callerSession,
    );

    expect(tasksInSeriesSession(OWNER_AGENT_GROUP_ID, 't-owned1')).toHaveLength(1);
  });

  // The series id becomes `system:tasks:<id>` and `tasks/<id>.md` on the host,
  // so a path-shaped id from an untrusted runner must never reach either.
  it('replaces a series id outside the host charset with a safe generated one', async () => {
    await fire(
      {
        action: 'schedule_task',
        seriesId: '../../etc/passwd',
        prompt: 'escape',
        processAfter: '2099-01-01T00:00:00.000Z',
      },
      callerSession,
    );

    const sessions = findTaskSessions(CALLER_AGENT_GROUP_ID);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].thread_id).toMatch(/^system:tasks:[a-z0-9-]+$/);
    const rows = withInboundDb(CALLER_AGENT_GROUP_ID, sessions[0].id, (db) =>
      db.prepare("SELECT id FROM messages_in WHERE kind = 'task'").all(),
    ) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^[a-z0-9-]+$/);
    expect(rows[0].id).not.toBe('../../etc/passwd');
  });

  it('rejects the fire when the caller holds grants on several owners', async () => {
    grantScheduleAdmin(CALLER_AGENT_GROUP_ID, OWNER_AGENT_GROUP_ID, 'test');
    seedGroup('ag-owner-two');
    grantScheduleAdmin(CALLER_AGENT_GROUP_ID, 'ag-owner-two', 'test');

    await expect(
      fire(
        { action: 'schedule_task', seriesId: 't-many1', prompt: 'ambiguous', processAfter: '2099-01-01T00:00:00.000Z' },
        callerSession,
      ),
    ).rejects.toThrow(/multiple schedule owners/);
  });
});
