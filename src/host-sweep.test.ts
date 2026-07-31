/**
 * Unit tests for the stuck-container decision logic introduced by
 * ACTION-ITEMS item 9. Lives on the pure helper `decideStuckAction` so we
 * don't have to mock the filesystem or the container runner.
 *
 * The `sweepSession — task GC placement` block near the bottom is the
 * exception: it drives `_sweepSessionForTesting` end-to-end (real
 * inbound.db, real central db) to pin the ordering of the recurrence hook
 * and the task-GC block introduced for the ncl-tasks port, following the
 * same container-runner/config mocking pattern as
 * `telegram-critical-path.test.ts`.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR, mockWakeContainer, mockIsContainerRunning } = vi.hoisted(() => ({
  TEST_DIR: '/tmp/nanoclaw-test-host-sweep-task-gc',
  mockWakeContainer: vi.fn(),
  mockIsContainerRunning: vi.fn(),
}));

vi.mock('./container-runner.js', () => ({
  wakeContainer: (...args: unknown[]) => mockWakeContainer(...args),
  isContainerRunning: (...args: unknown[]) => mockIsContainerRunning(...args),
  killContainer: vi.fn(),
  getContainerStartedAtMs: vi.fn().mockReturnValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { getSession } from './db/sessions.js';
import { deleteOrphanProcessingClaims, getProcessingClaims } from './db/session-db.js';
import {
  ABSOLUTE_CEILING_MS,
  CLAIM_STUCK_MS,
  PENDING_STUCK_MS,
  _resetStuckProcessingRowsForTesting,
  _sweepSessionForTesting,
  decideStuckAction,
  parseSqliteUtc,
  shouldCloseTaskSession,
  shouldStopSpentTaskContainer,
} from './host-sweep.js';
import { inboundDbPath, resolveTaskSession } from './session-manager.js';
import type { Session } from './types.js';

const BASE = Date.parse('2026-04-20T12:00:00.000Z');

function claim(id: string, offsetMs: number) {
  return { message_id: id, status_changed: new Date(BASE - offsetMs).toISOString() };
}

describe('decideStuckAction', () => {
  it('returns ok when heartbeat is fresh and no claims', () => {
    expect(
      decideStuckAction({
        now: BASE,
        heartbeatMtimeMs: BASE - 5_000,
        containerState: null,
        claims: [],
      }),
    ).toEqual({ action: 'ok' });
  });

  it('returns kill-ceiling when heartbeat older than 30 min', () => {
    const heartbeatMtimeMs = BASE - ABSOLUTE_CEILING_MS - 1_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('kill-ceiling');
    if (res.action !== 'kill-ceiling') return;
    expect(res.ceilingMs).toBe(ABSOLUTE_CEILING_MS);
    expect(res.heartbeatAgeMs).toBeGreaterThan(ABSOLUTE_CEILING_MS);
  });

  it('skips the ceiling check when no heartbeat file exists (fresh container not yet ticked)', () => {
    // A freshly-spawned container hasn't produced any SDK events yet, so no
    // heartbeat. Prior behavior treated this as infinitely stale and killed
    // every container within seconds of spawn. With no claims either, we
    // should conclude everything is fine.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('kills on claim-stuck when heartbeat is absent AND a claim has aged past tolerance', () => {
    // Hanging fresh container: spawned, picked up a message (claim recorded
    // in processing_ack), but never wrote a heartbeat. Falls through the
    // skipped ceiling check into claim-stuck — which correctly fires.
    const claimedAgeMs = CLAIM_STUCK_MS + 5_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
  });

  it('extends the ceiling when Bash has a declared timeout longer than 30 min', () => {
    const twoHrMs = 2 * 60 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // 45 min — over the default ceiling, but under the Bash timeout
      heartbeatMtimeMs: BASE - 45 * 60 * 1000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: twoHrMs,
        tool_started_at: new Date(BASE - 45 * 60 * 1000).toISOString(),
      },
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('returns kill-claim when a claim is past 60s and heartbeat has not moved', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - claimedAgeMs - 5_000, // older than the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
    if (res.action !== 'kill-claim') return;
    expect(res.messageId).toBe('msg-1');
    expect(res.toleranceMs).toBe(CLAIM_STUCK_MS);
  });

  it('does not kill when heartbeat has been touched since the claim', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 2_000, // fresh, updated after the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('ok');
  });

  it('does not kill when claim age is below tolerance', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - CLAIM_STUCK_MS - 10_000, // old, but claim is recent
      containerState: null,
      claims: [claim('msg-1', 5_000)],
    });
    expect(res.action).toBe('ok');
  });

  it('widens per-claim tolerance for a running Bash with long timeout', () => {
    const tenMinMs = 10 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // 5 min since claim, over the 60s default but under the declared Bash timeout
      heartbeatMtimeMs: BASE - 5 * 60 * 1000 - 5_000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: tenMinMs,
        tool_started_at: new Date(BASE - 5 * 60 * 1000).toISOString(),
      },
      claims: [claim('msg-1', 5 * 60 * 1000)],
    });
    expect(res.action).toBe('ok');
  });

  it('ignores claims with unparseable timestamps', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 5_000,
      containerState: null,
      claims: [{ message_id: 'x', status_changed: 'not-a-date' }],
    });
    expect(res.action).toBe('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orphan claim cleanup (regression test for the SIGKILL → claim-stuck loop)
//
// Repro of the production bug seen 2026-04-30: container A claimed message M
// (writes processing_ack row with status='processing'). Host kills A by
// absolute-ceiling. Old behavior: messages_in.M was reset to pending but
// processing_ack.M survived. On the next sweep tick, wakeContainer spawned B,
// the same-tick SLA check saw M's stale claim age (hours), and SIGKILL'd B
// before agent-runner could run clearStaleProcessingAcks(). Loop. The fix
// deletes processing_ack 'processing' rows when the host kills/cleans the
// container, breaking the loop atomically.
// ─────────────────────────────────────────────────────────────────────────────

function makeSessionDbs(): { inDb: Database.Database; outDb: Database.Database } {
  const inDb = new Database(':memory:');
  inDb.exec(`
    CREATE TABLE messages_in (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      kind          TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      process_after TEXT,
      recurrence    TEXT,
      series_id     TEXT,
      tries         INTEGER DEFAULT 0,
      trigger       INTEGER NOT NULL DEFAULT 1,
      platform_id   TEXT,
      channel_type  TEXT,
      thread_id     TEXT,
      content       TEXT NOT NULL
    );
  `);
  const outDb = new Database(':memory:');
  outDb.exec(`
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
  `);
  return { inDb, outDb };
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

describe('deleteOrphanProcessingClaims', () => {
  it('removes only processing rows, leaves completed/failed alone', () => {
    const { outDb } = makeSessionDbs();
    const ts = new Date().toISOString();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-proc', 'processing', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-done', 'completed', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-fail', 'failed', ?)").run(ts);

    const removed = deleteOrphanProcessingClaims(outDb);

    expect(removed).toBe(1);
    const remaining = outDb.prepare('SELECT message_id, status FROM processing_ack ORDER BY message_id').all();
    expect(remaining).toEqual([
      { message_id: 'm-done', status: 'completed' },
      { message_id: 'm-fail', status: 'failed' },
    ]);
  });

  it('returns 0 when nothing to clear', () => {
    const { outDb } = makeSessionDbs();
    expect(deleteOrphanProcessingClaims(outDb)).toBe(0);
  });
});

describe('resetStuckProcessingRows — orphan claim cleanup', () => {
  it('deletes orphan processing_ack rows so next sweep tick does not see them', () => {
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago

    // messages_in.status stays 'pending' during processing — only the
    // container's processing_ack moves to 'processing'. See
    // src/db/schema.ts header comment on processing_ack.
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-1', 1, 'chat', ?, 'pending', '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-1', 'processing', ?)").run(claimedAt);

    // Sanity: the orphan claim is what would trip claim-stuck.
    expect(getProcessingClaims(outDb)).toHaveLength(1);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'absolute-ceiling');

    // Regression assertion: orphan claim is gone — next sweep tick will see
    // an empty claims list and not kill the freshly respawned container.
    expect(getProcessingClaims(outDb)).toEqual([]);

    // And the message itself was rescheduled with backoff (existing behavior).
    const row = inDb.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get('m-1') as {
      status: string;
      tries: number;
      process_after: string | null;
    };
    expect(row.status).toBe('pending');
    expect(row.tries).toBe(1);
    expect(row.process_after).not.toBeNull();
  });

  it('still clears orphan claims even when the inbound message has already been retried (skip path)', () => {
    // Edge case: the inbound row was already rescheduled (process_after in
    // future), so the per-message retry loop skips it. The orphan in
    // processing_ack must still be removed — otherwise the bug remains.
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, tries, content) VALUES ('m-2', 2, 'chat', ?, 'pending', ?, 1, '{}')",
      )
      .run(claimedAt, future);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-2', 'processing', ?)").run(claimedAt);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck');

    expect(getProcessingClaims(outDb)).toEqual([]);
    const row = inDb.prepare('SELECT tries FROM messages_in WHERE id = ?').get('m-2') as { tries: number };
    expect(row.tries).toBe(1); // not bumped, the skip path held
  });
});

describe('decideStuckAction — pending-stuck (production bug: long task blocks poll loop)', () => {
  it('returns ok when there are no pending messages', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 5_000,
      containerState: null,
      claims: [],
      oldestDuePendingAgeMs: 0,
    });
    expect(res.action).toBe('ok');
  });

  it('returns ok when pending message age is below PENDING_STUCK_MS', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 5_000,
      containerState: null,
      claims: [],
      oldestDuePendingAgeMs: PENDING_STUCK_MS - 1_000,
    });
    expect(res.action).toBe('ok');
  });

  it('returns kill-pending-stuck when pending message waited past PENDING_STUCK_MS', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 5_000,
      containerState: null,
      claims: [],
      oldestDuePendingAgeMs: PENDING_STUCK_MS + 1_000,
    });
    expect(res.action).toBe('kill-pending-stuck');
    if (res.action !== 'kill-pending-stuck') return;
    expect(res.oldestPendingAgeMs).toBeGreaterThan(PENDING_STUCK_MS);
    expect(res.thresholdMs).toBe(PENDING_STUCK_MS);
  });

  it('fires kill-pending-stuck even when an active claim exists and heartbeat is fresh — exact production scenario', () => {
    // Container was alive (fresh heartbeat), processing a 58-min scheduled task
    // (claim exists, heartbeat moved after claim → claim-stuck does NOT fire).
    // User messages piled up as pending. No check detected them. This test
    // covers that exact gap.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 5_000, // heartbeat fresh → ceiling OK, claim-stuck skips
      containerState: null,
      claims: [claim('msg-scheduled', 58 * 60_000)], // 58-min claim, fresh heartbeat → claim-stuck skips
      oldestDuePendingAgeMs: PENDING_STUCK_MS + 1_000,
    });
    expect(res.action).toBe('kill-pending-stuck');
  });

  it('extends pending-stuck threshold when Bash has a declared timeout longer than PENDING_STUCK_MS', () => {
    // Bash timeout (20 min) > PENDING_STUCK_MS (10 min) → threshold becomes 20 min.
    // pending age (10 min + 1 sec) is below that extended threshold → ok.
    const twentyMinMs = 20 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 5_000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: twentyMinMs,
        tool_started_at: new Date(BASE - 5 * 60 * 1000).toISOString(),
      },
      claims: [],
      oldestDuePendingAgeMs: PENDING_STUCK_MS + 1_000, // over default but under 20-min Bash threshold
    });
    expect(res.action).toBe('ok');
  });

  it('existing tests still pass without oldestDuePendingAgeMs (default 0 = no pending)', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 5_000,
      containerState: null,
      claims: [],
      // oldestDuePendingAgeMs omitted → defaults to 0
    });
    expect(res.action).toBe('ok');
  });

  it('does not kill when heartbeat is absent even though old pending messages exist (freshly-spawned container)', () => {
    // Regression test for the spawn-kill loop:
    // Sweep kills container for pending-stuck → onExit respawns it → sweep
    // kills it again in 5ms before the agent-runner can start → infinite loop.
    // Root cause: pending-stuck fired even when heartbeatMtimeMs===0 (no
    // heartbeat written yet = container just spawned). Fix: guard the
    // pending-stuck check with heartbeatMtimeMs !== 0, same as ceiling.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0, // freshly-spawned container: no heartbeat yet
      containerState: null,
      claims: [],
      oldestDuePendingAgeMs: PENDING_STUCK_MS + 60 * 60 * 1000, // 1h+ old messages
    });
    expect(res.action).toBe('ok');
  });

  it('still kills when heartbeat exists and old pending messages are blocked (normal pending-stuck scenario)', () => {
    // Ensure the guard does not suppress legitimate pending-stuck kills for
    // containers that ARE running (heartbeat present) but ignoring new messages.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 5_000, // container is alive and heartbeating
      containerState: null,
      claims: [],
      oldestDuePendingAgeMs: PENDING_STUCK_MS + 60 * 60 * 1000, // 1h+ old messages
    });
    expect(res.action).toBe('kill-pending-stuck');
  });

  it('gives a new container a full pending-stuck window for a pre-existing backlog', () => {
    const fresh = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 5_000,
      containerState: null,
      claims: [claim('active-backlog-item', 30_000)],
      oldestDuePendingAgeMs: 30 * 24 * 60 * 60 * 1000,
      containerUptimeMs: 60_000,
    });
    expect(fresh.action).toBe('ok');

    const exhausted = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 5_000,
      containerState: null,
      claims: [claim('active-backlog-item', 11 * 60_000)],
      oldestDuePendingAgeMs: 30 * 24 * 60 * 60 * 1000,
      containerUptimeMs: PENDING_STUCK_MS + 1_000,
    });
    expect(exhausted.action).toBe('kill-pending-stuck');
  });
});

describe('parseSqliteUtc', () => {
  // Regression: SQLite TIMESTAMP strings have no zone marker, but Date.parse
  // treats those as local time. On non-UTC hosts this made every claim look
  // (TZ offset) hours stale and tripped kill-claim on freshly-claimed messages.
  // The helper appends "Z" only when no marker is present, so parsing is
  // always anchored to UTC regardless of host timezone.

  const utcMs = Date.parse('2026-04-20T12:00:00.000Z');

  it('treats a SQLite-style timestamp (no zone) as UTC', () => {
    expect(parseSqliteUtc('2026-04-20 12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00.000')).toBe(utcMs);
  });

  it('preserves an explicit Z marker', () => {
    expect(parseSqliteUtc('2026-04-20T12:00:00.000Z')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00z')).toBe(utcMs);
  });

  it('preserves an explicit numeric offset', () => {
    // 14:00+02:00 == 12:00 UTC
    expect(parseSqliteUtc('2026-04-20T14:00:00+02:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T14:00:00+0200')).toBe(utcMs);
    // 07:00-05:00 == 12:00 UTC
    expect(parseSqliteUtc('2026-04-20T07:00:00-05:00')).toBe(utcMs);
  });

  it('returns NaN for unparseable input', () => {
    expect(Number.isNaN(parseSqliteUtc('not a date'))).toBe(true);
  });

  it('does not drift across host timezones for SQLite-style input', () => {
    // The helper itself is timezone-independent because it forces UTC parsing.
    // (Verifying the regex branch — without the helper, `Date.parse` of the
    // bare string returns different values depending on the host TZ.)
    const bare = '2026-04-20T12:00:00';
    expect(parseSqliteUtc(bare)).toBe(Date.parse(bare + 'Z'));
  });
});

describe('shouldCloseTaskSession', () => {
  it('closes only a task session with no live rows and no container', () => {
    expect(shouldCloseTaskSession('system:tasks:daily-1a2b', false, 0)).toBe(true);
  });

  it('keeps a task session that still has a live row', () => {
    expect(shouldCloseTaskSession('system:tasks:daily-1a2b', false, 1)).toBe(false);
  });

  it('keeps a task session whose container is still running', () => {
    expect(shouldCloseTaskSession('system:tasks:daily-1a2b', true, 0)).toBe(false);
  });

  // Regression for the ncl-tasks port — a chat session with an empty inbox is
  // not spent; closing it would kill the live conversation.
  it('never closes a non-task session', () => {
    expect(shouldCloseTaskSession('thread-1', false, 0)).toBe(false);
    expect(shouldCloseTaskSession(null, false, 0)).toBe(false);
  });
});

describe('shouldStopSpentTaskContainer', () => {
  it('stops a task container after its final live row completes', () => {
    expect(shouldStopSpentTaskContainer('system:tasks:daily-1a2b', true, 0)).toBe(true);
  });

  it('keeps recurring work and non-task containers alive', () => {
    expect(shouldStopSpentTaskContainer('system:tasks:daily-1a2b', true, 1)).toBe(false);
    expect(shouldStopSpentTaskContainer('thread-1', true, 0)).toBe(false);
    expect(shouldStopSpentTaskContainer(null, true, 0)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Placement regression: the task-GC block in sweepSession must run AFTER the
// recurrence hook, never before. `shouldCloseTaskSession` alone can't catch a
// reordering — it's correct in isolation either way. Only driving the real
// `sweepSession` (via `_sweepSessionForTesting`) against a real inbound.db
// proves the two blocks fire in the right order: a series that just fired
// must already have its next occurrence re-armed before the live-row count
// is taken, or GC reads a false zero and kills a healthy recurring series on
// its first fire.
// ─────────────────────────────────────────────────────────────────────────────
describe('sweepSession — task GC placement (must run after recurrence)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    mockWakeContainer.mockReset();
    mockWakeContainer.mockResolvedValue(true);
    mockIsContainerRunning.mockReset();
    mockIsContainerRunning.mockReturnValue(false);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('a recurring series survives its own fire — recurrence re-arms the next occurrence before GC counts live rows', async () => {
    createAgentGroup({
      id: 'ag-task-gc-recurring',
      name: 'Task GC Recurring',
      folder: 'task-gc-recurring',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const { session } = resolveTaskSession('ag-task-gc-recurring', 'series-recurring');

    // Seed the one occurrence as just-completed, still carrying its cron
    // recurrence — exactly what handleRecurrence looks for.
    const inDb = new Database(inboundDbPath('ag-task-gc-recurring', session.id));
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, recurrence, series_id, content)
         VALUES ('task-1', 1, 'task', datetime('now'), 'completed', '0 9 * * *', 'series-recurring', '{}')`,
      )
      .run();
    inDb.close();

    await _sweepSessionForTesting(session);

    // This is the assertion that goes red if the GC block is ever moved
    // ahead of the recurrence hook.
    const after = getSession(session.id)!;
    expect(after.status).toBe('active');

    // Sanity: recurrence actually fired (next pending occurrence exists,
    // original row's recurrence cleared) — otherwise the test would pass
    // for the wrong reason.
    const seriesDb = new Database(inboundDbPath('ag-task-gc-recurring', session.id), { readonly: true });
    const rows = seriesDb
      .prepare("SELECT status, recurrence FROM messages_in WHERE series_id = 'series-recurring' ORDER BY seq")
      .all() as Array<{ status: string; recurrence: string | null }>;
    seriesDb.close();
    expect(rows).toEqual([
      { status: 'completed', recurrence: null },
      { status: 'pending', recurrence: '0 9 * * *' },
    ]);
  });

  it('a spent one-shot task session is collected — completed, no recurrence, no container', async () => {
    createAgentGroup({
      id: 'ag-task-gc-oneshot',
      name: 'Task GC Oneshot',
      folder: 'task-gc-oneshot',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const { session } = resolveTaskSession('ag-task-gc-oneshot', 'series-oneshot');

    const inDb = new Database(inboundDbPath('ag-task-gc-oneshot', session.id));
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, series_id, content)
         VALUES ('task-2', 1, 'task', datetime('now'), 'completed', 'series-oneshot', '{}')`,
      )
      .run();
    inDb.close();

    await _sweepSessionForTesting(session);

    const after = getSession(session.id)!;
    expect(after.status).toBe('closed');
  });
});
