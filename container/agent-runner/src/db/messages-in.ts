/**
 * Inbound message operations (container side).
 *
 * Reads from inbound.db (host-owned, opened read-only).
 * Writes processing status to processing_ack in outbound.db (container-owned).
 *
 * The container never writes to inbound.db — all status tracking goes through
 * processing_ack. The host reads processing_ack to sync message lifecycle.
 */
import { getConfig } from '../config.js';
import { openInboundDb, getOutboundDb } from './connection.js';

// Cache whether inbound.db has the on_wake column (added in v2.0.48).
// The container opens inbound.db read-only, so it can't ALTER —
// gracefully degrade when running against an older session DB.
let _hasOnWake: boolean | null = null;
function hasOnWakeColumn(db: ReturnType<typeof openInboundDb>): boolean {
  if (_hasOnWake !== null) return _hasOnWake;
  const cols = new Set(
    (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  _hasOnWake = cols.has('on_wake');
  return _hasOnWake;
}

export interface MessageInRow {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  tries: number;
  /** 1 = wake-eligible (default); 0 = accumulated context only */
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  orchestration_run_id?: string | null;
}

// Cap on how many messages reach the agent in one prompt. Read from
// container.json; falls back to 10.
function getMaxMessagesPerPrompt(): number {
  try {
    return getConfig().maxMessagesPerPrompt;
  } catch {
    // Config not loaded yet (e.g. test harness) — use default
    return 10;
  }
}

/**
 * Fetch pending messages that are due for processing.
 * Reads from inbound.db (read-only), filters against processing_ack in outbound.db
 * to skip messages already picked up by this or a previous container run.
 *
 * Two-phase selection, capped at `maxMessagesPerPrompt` (ported from upstream
 * bac2e3f0 + 9821c0fb):
 * 1. every due wake-eligible row (trigger=1), oldest-first, up to the cap —
 *    accumulated context (trigger=0) can never crowd a due task or message
 *    out of the batch;
 * 2. remaining slots filled with the NEWEST context rows, so the agent sees the
 *    prior context it missed.
 * The result is merged in chronological order. Claimed rows are dropped BEFORE
 * windowing: they stay status='pending' in inbound.db until the host sweep
 * syncs processing_ack back (~60s), and windowing first would let a full
 * claimed batch hide newer work for the rest of the turn. Host-side
 * countDueMessages gates waking on trigger=1 separately (see
 * src/db/session-db.ts).
 */
export function getPendingMessages(isFirstPoll = false): MessageInRow[] {
  const inbound = openInboundDb();
  const outbound = getOutboundDb();

  try {
    const cap = getMaxMessagesPerPrompt();
    const hasOnWake = hasOnWakeColumn(inbound);
    const stmt = inbound.prepare(
      `SELECT * FROM messages_in
       WHERE status = 'pending'
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
         ${hasOnWake ? 'AND (on_wake = 0 OR ?1 = 1)' : ''}
       ORDER BY seq ASC`,
    );
    const due = (hasOnWake ? stmt.all(isFirstPoll ? 1 : 0) : stmt.all()) as MessageInRow[];
    if (due.length === 0) return [];

    const ackedIds = new Set(
      (outbound.prepare('SELECT message_id FROM processing_ack').all() as Array<{ message_id: string }>).map(
        (r) => r.message_id,
      ),
    );
    const unclaimed = due.filter((m) => !ackedIds.has(m.id));

    const wakeRows = unclaimed.filter((m) => m.trigger === 1).slice(0, cap);
    const remaining = cap - wakeRows.length;
    const contextRows = remaining > 0 ? unclaimed.filter((m) => m.trigger === 0).slice(-remaining) : [];

    // JS sort is stable, so ties (null seq in tests) keep wake rows first.
    return [...wakeRows, ...contextRows].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  } finally {
    inbound.close();
  }
}

/** Mark messages as processing — writes to processing_ack in outbound.db. */
export function markProcessing(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', ?)",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(id, new Date().toISOString());
  })();
}

/**
 * Mark messages as completed — updates processing_ack in outbound.db.
 *
 * Only claims still in 'processing' are advanced. `markCompleted` doubles as
 * the poll loop's idempotent safety net, so a blind INSERT OR REPLACE would
 * overwrite a terminal ack written earlier in the same batch — turning a
 * `provider-error` task fire back into a successful run on any path where the
 * loop reaches the safety net without knowing the batch already failed
 * (notably processQuery throwing after it acked).
 */
export function markCompleted(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    `INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, 'completed', ?)
       ON CONFLICT(message_id) DO UPDATE SET status = 'completed', status_changed = excluded.status_changed
        WHERE processing_ack.status = 'processing'`,
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(id, new Date().toISOString());
  })();
}

/** Mark task messages as failed because the provider could not process them. */
export function markProviderFailed(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'provider-error', ?)",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(id, new Date().toISOString());
  })();
}

/**
 * Ack task messages whose pre-task script gated the run. The reason decides
 * the ack: `gated` (wakeAgent=false) is the monitor working as designed → a
 * plain `completed`; `error` (broken script) → `script-skip:error`, which the
 * host's ack sync records as a FAILED run so recurrence can read the trailing
 * failed streak off the occurrence rows and back the series off.
 */
export function markScriptSkipped(skips: Array<{ id: string; reason: string }>): void {
  if (skips.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, datetime('now'))",
  );
  db.transaction(() => {
    for (const s of skips) stmt.run(s.id, s.reason === 'error' ? 'script-skip:error' : 'completed');
  })();
}

/** Get a message by ID (read from inbound.db). */
export function getMessageIn(id: string): MessageInRow | undefined {
  const inbound = openInboundDb();
  try {
    return inbound.prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as MessageInRow | undefined;
  } finally {
    inbound.close();
  }
}

/**
 * Find a pending response to a question (by questionId in content).
 * Reads from inbound.db, checks processing_ack to skip already-handled responses.
 */
export function findQuestionResponse(questionId: string): MessageInRow | undefined {
  const inbound = openInboundDb();
  const outbound = getOutboundDb();

  try {
    const response = inbound
      .prepare("SELECT * FROM messages_in WHERE status = 'pending' AND content LIKE ?")
      .get(`%"questionId":"${questionId}"%`) as MessageInRow | undefined;

    if (!response) return undefined;

    // Check it hasn't been acked already
    const acked = outbound.prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get(response.id);
    if (acked) return undefined;

    return response;
  } finally {
    inbound.close();
  }
}
