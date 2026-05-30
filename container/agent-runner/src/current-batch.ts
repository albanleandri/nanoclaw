/**
 * Per-batch context the poll loop publishes for downstream consumers
 * (MCP tools, etc.) that don't sit on the poll-loop's call stack.
 *
 * Today the only field is `inReplyTo` — the id of the first inbound
 * message in the batch the agent is currently processing. MCP tools like
 * `send_message` and `send_file` read this and stamp it onto the outbound
 * row so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * The poll loop and MCP tools may run in separate processes. Poll-loop
 * stores the value in memory and in outbound.db session_state before invoking
 * the provider; MCP child processes read the DB row when module memory is empty.
 */
import { getOutboundDb } from './db/connection.js';

const CURRENT_IN_REPLY_TO_KEY = 'runtime:current_in_reply_to';

let currentInReplyTo: string | null = null;

export function setCurrentInReplyTo(id: string | null): void {
  currentInReplyTo = id;
  const db = getOutboundDb();
  if (id) {
    db.prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      CURRENT_IN_REPLY_TO_KEY,
      id,
      new Date().toISOString(),
    );
  } else {
    db.prepare('DELETE FROM session_state WHERE key = ?').run(CURRENT_IN_REPLY_TO_KEY);
  }
}

export function clearCurrentInReplyTo(): void {
  currentInReplyTo = null;
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(CURRENT_IN_REPLY_TO_KEY);
}

export function getCurrentInReplyTo(): string | null {
  if (currentInReplyTo) return currentInReplyTo;
  const row = getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?').get(CURRENT_IN_REPLY_TO_KEY) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}
