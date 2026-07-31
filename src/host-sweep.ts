/**
 * Host sweep — periodic maintenance of all session DBs.
 *
 * Two-DB architecture:
 *   - Reads processing_ack + container_state from outbound.db
 *   - Writes to inbound.db (host-owned) for status updates + recurrence
 *   - Uses heartbeat file mtime for liveness (never polls DB for it)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 *
 * Stuck / idle detection (replaces the old IDLE_TIMEOUT setTimeout + 10-min
 * heartbeat threshold):
 *
 *   If the container isn't running and there are 'processing' rows left over
 *   (e.g. it crashed mid-turn) → reset them to pending with backoff +
 *   tries++. Existing retry machinery does the rest.
 *
 *   If the container IS running:
 *     1. Absolute ceiling: heartbeat age > max(30 min, current_bash_timeout)
 *        → kill. Covers the "alive but silent for 30 min" case. Extended
 *        only while Bash is declared as running longer, honouring the
 *        user's own timeout directive. Kill then resets processing rows.
 *
 *     2. Message-scoped stuck: for each 'processing' row, tolerance =
 *        max(60s, current_bash_timeout_ms_if_Bash_running). If
 *        (claim_age > tolerance) AND (heartbeat_mtime <= status_changed)
 *        → kill + reset this message + tries++. Semantics: "container
 *        claimed a message and went quiet past tolerance since the claim."
 */
import type Database from 'better-sqlite3';
import fs from 'fs';

import { getActiveSessions, isTaskThread, updateSession } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { ensureEgressNetwork } from './egress-lockdown.js';
import {
  countDueMessages,
  deleteOrphanProcessingClaims,
  getContainerState,
  getMessageForRetry,
  getOldestDuePendingTimestamp,
  getProcessingClaims,
  markMessageFailed,
  retryWithBackoff,
  syncProcessingAcks,
  type ContainerState,
} from './db/session-db.js';
import { log } from './log.js';
import { recoverFallbackDispatches } from './orchestration/fallback-dispatcher.js';
import { recoverOrchestrationRuns } from './orchestration/run-store.js';
import { openInboundDb, openOutboundDb, openOutboundDbRw, inboundDbPath, heartbeatPath } from './session-manager.js';
import { getContainerStartedAtMs, isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import type { Session } from './types.js';

/**
 * SQLite TIMESTAMP columns store UTC without a timezone marker. Date.parse
 * treats timezoneless ISO strings as local time, so on non-UTC hosts every
 * timestamp looks (TZ offset) hours stale — leading to spurious kill-claim
 * decisions on freshly-claimed messages. Append "Z" when no zone marker is
 * present so Date.parse interprets the string as UTC.
 */
export function parseSqliteUtc(s: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
}

const SWEEP_INTERVAL_MS = 60_000;
// Absolute idle ceiling for a running container. If the heartbeat file hasn't
// been touched in this long, the container is either stuck or doing genuinely
// nothing — kill and restart on the next inbound.
export const ABSOLUTE_CEILING_MS = 30 * 60 * 1000;
// Stuck tolerance window applied per 'processing' claim — "did we see any
// signs of life since this message was claimed?"
export const CLAIM_STUCK_MS = 60 * 1000;
// Maximum time a pending (unclaimed) trigger message may wait while the
// container is alive. Guards against a poll loop blocked on a long API call
// — the container heartbeats normally so ceiling/claim-stuck don't fire, but
// new user messages pile up without being processed.
export const PENDING_STUCK_MS = 10 * 60 * 1000;
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number }
  | { action: 'kill-pending-stuck'; oldestPendingAgeMs: number; thresholdMs: number };

/**
 * Pure decision for whether a running container should be killed this sweep
 * tick. Inputs are all deterministic; filesystem + DB reads happen in the
 * caller.
 */
export function decideStuckAction(args: {
  now: number;
  heartbeatMtimeMs: number; // 0 when heartbeat file absent
  containerState: ContainerState | null;
  claims: Array<{ message_id: string; status_changed: string }>;
  /** Age in ms of the oldest due-pending trigger message; 0 if none. */
  oldestDuePendingAgeMs?: number;
  /** Uptime of the current container instance; omitted by legacy callers. */
  containerUptimeMs?: number;
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerState, claims, oldestDuePendingAgeMs = 0, containerUptimeMs } = args;
  const declaredBashMs = bashTimeoutMs(containerState);

  // Ceiling check only applies when we have an actual heartbeat timestamp.
  // A freshly-spawned container hasn't had any SDK activity yet so no
  // heartbeat file exists — if we treated that as infinitely stale we'd
  // kill every container within seconds of spawn. Genuinely-dead containers
  // that never wrote a heartbeat are caught by the separate "container
  // process not running" cleanup path, not here. If a fresh container is
  // hanging at the gate (claimed a message but never did anything) the
  // claim-stuck check below handles it.
  if (heartbeatMtimeMs !== 0) {
    const heartbeatAge = now - heartbeatMtimeMs;
    const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredBashMs ?? 0);
    if (heartbeatAge > ceiling) {
      return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
    }
  }

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0);
  for (const claim of claims) {
    const claimedAt = parseSqliteUtc(claim.status_changed);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    if (heartbeatMtimeMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.message_id, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  // Pending-stuck: a trigger message has been waiting in inbound.db unclaimed
  // for longer than the threshold. Catches the case where the poll loop is
  // blocked on a long API call — the container heartbeats normally so the
  // ceiling and claim-stuck checks above don't fire, but new user messages
  // pile up as 'pending' without ever being processed.
  //
  // Guard on heartbeat presence for the same reason as ceiling: a freshly-
  // spawned container hasn't written its first heartbeat yet. Killing it for
  // pending-stuck before it even starts creates a spawn-kill loop when old
  // unprocessed messages exceed the threshold.
  const pendingThreshold = Math.max(PENDING_STUCK_MS, declaredBashMs ?? 0);
  const effectivePendingAgeMs =
    containerUptimeMs === undefined
      ? oldestDuePendingAgeMs
      : Math.min(oldestDuePendingAgeMs, Math.max(0, containerUptimeMs));
  if (heartbeatMtimeMs !== 0 && effectivePendingAgeMs > pendingThreshold) {
    return { action: 'kill-pending-stuck', oldestPendingAgeMs: effectivePendingAgeMs, thresholdMs: pendingThreshold };
  }

  return { action: 'ok' };
}

let running = false;

export function startHostSweep(): void {
  if (running) return;
  running = true;
  sweep();
}

export function stopHostSweep(): void {
  running = false;
}

async function sweep(): Promise<void> {
  if (!running) return;

  try {
    ensureEgressNetwork();
  } catch (err) {
    log.error('Egress lockdown re-heal failed', { err });
  }

  try {
    const recovered = recoverOrchestrationRuns();
    if (recovered.expiredLeases > 0 || recovered.expiredRuns > 0) {
      log.warn('Recovered expired orchestration work', recovered);
    }
    const fallbackRecovery = await recoverFallbackDispatches();
    if (fallbackRecovery.recovered > 0 || fallbackRecovery.failed > 0) {
      log.warn('Recovered queued fallback dispatches', fallbackRecovery);
    }
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await sweepSession(session);
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  setTimeout(sweep, SWEEP_INTERVAL_MS);
}

/** A per-task session with no live tasks and no running container is spent → close it. */
export function shouldCloseTaskSession(
  threadId: string | null,
  containerRunning: boolean,
  liveTaskCount: number,
): boolean {
  return isTaskThread(threadId) && !containerRunning && liveTaskCount === 0;
}

/** A completed one-shot task container has no future work and must exit so
 *  the following sweep can close its spent session. */
export function shouldStopSpentTaskContainer(
  threadId: string | null,
  containerRunning: boolean,
  liveTaskCount: number,
): boolean {
  return isTaskThread(threadId) && containerRunning && liveTaskCount === 0;
}

async function sweepSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const inPath = inboundDbPath(agentGroup.id, session.id);
  if (!fs.existsSync(inPath)) return;

  let inDb: Database.Database;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return;
  }

  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
  } catch {
    // outbound.db might not exist yet (container hasn't started)
  }

  try {
    // 1. Sync processing_ack → messages_in status
    if (outDb) {
      syncProcessingAcks(inDb, outDb);
    }

    // 2. Wake a container if work is due and nothing is running. Ordered
    // before the crashed-container cleanup so a fresh container gets a chance
    // to clean its own orphan processing_ack rows on startup (see
    // container/agent-runner/src/db/connection.ts). Otherwise the reset path
    // would keep bumping process_after into the future, dueCount would stay 0,
    // and the wake would never fire.
    const dueCount = countDueMessages(inDb);
    let justWoke = false;
    if (dueCount > 0 && !isContainerRunning(session.id)) {
      log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
      // wakeContainer never throws — transient spawn failures (OneCLI down,
      // etc.) return false and leave messages pending for the next tick.
      await wakeContainer(session);
      justWoke = true;
    }

    const alive = isContainerRunning(session.id);

    // 3. Running-container SLA: absolute ceiling + per-claim stuck rules.
    // Skip on the same iteration that just woke the container — it hasn't
    // had a chance to clear stale processing_ack rows from a previous crash
    // yet. Without this grace period, stale claims cause an immediate
    // spawn-kill loop.
    if (alive && outDb && !justWoke) {
      enforceRunningContainerSla(inDb, outDb, session, agentGroup.id);
    }

    // 4. Crashed-container cleanup: processing rows left behind get retried.
    // Only fires when wake in step 2 didn't pick up the work (no due messages,
    // or wake failed). resetStuckProcessingRows itself is idempotent — it
    // skips messages already scheduled for a future retry.
    if (!alive && outDb) {
      resetStuckProcessingRows(inDb, outDb, session, 'container not running');
    }

    // 5. Recurrence fanout for completed recurring tasks.
    // MODULE-HOOK:scheduling-recurrence:start
    const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
    await handleRecurrence(inDb, session, outDb);
    // MODULE-HOOK:scheduling-recurrence:end

    // GC spent task sessions. An isolated per-task session with no live task
    // rows left (one-shot fired, or all cancelled/deleted) and no container
    // running is dead — close it so it stops being swept and listed. Runs after
    // recurrence so a just-fired recurring series has already re-armed its next
    // pending row and is never collected. The per-task log file in the workspace
    // is the durable history and survives the close.
    if (isTaskThread(session.thread_id)) {
      const liveTasks = (
        inDb
          .prepare("SELECT COUNT(*) AS c FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused')")
          .get() as { c: number }
      ).c;
      const taskContainerRunning = isContainerRunning(session.id);
      if (shouldStopSpentTaskContainer(session.thread_id, taskContainerRunning, liveTasks)) {
        killContainer(session.id, 'spent-task-session');
      } else if (shouldCloseTaskSession(session.thread_id, taskContainerRunning, liveTasks)) {
        updateSession(session.id, { status: 'closed' });
        log.info('Closed spent task session', { sessionId: session.id, threadId: session.thread_id });
      }
    }
  } finally {
    inDb.close();
    outDb?.close();
  }
}

export const _sweepSessionForTesting = sweepSession;

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

function bashTimeoutMs(state: ContainerState | null): number | null {
  if (!state || state.current_tool !== 'Bash') return null;
  return typeof state.tool_declared_timeout_ms === 'number' ? state.tool_declared_timeout_ms : null;
}

function enforceRunningContainerSla(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupId: string,
): void {
  const now = Date.now();
  const oldestTs = getOldestDuePendingTimestamp(inDb);
  const oldestDuePendingAgeMs = oldestTs ? Math.max(0, now - parseSqliteUtc(oldestTs)) : 0;
  const containerStartedAtMs = getContainerStartedAtMs(session.id);

  const decision = decideStuckAction({
    now,
    heartbeatMtimeMs: heartbeatMtimeMs(agentGroupId, session.id),
    containerState: getContainerState(outDb),
    claims: getProcessingClaims(outDb),
    oldestDuePendingAgeMs,
    containerUptimeMs: containerStartedAtMs === undefined ? undefined : Math.max(0, now - containerStartedAtMs),
  });

  if (decision.action === 'ok') return;

  if (decision.action === 'kill-ceiling') {
    log.warn('Killing container past absolute ceiling', {
      sessionId: session.id,
      heartbeatAgeMs: decision.heartbeatAgeMs,
      ceilingMs: decision.ceilingMs,
    });
    killContainer(session.id, 'absolute-ceiling');
    resetStuckProcessingRows(inDb, outDb, session, 'absolute-ceiling');
    return;
  }

  if (decision.action === 'kill-claim') {
    log.warn('Killing container — message claimed then silent', {
      sessionId: session.id,
      messageId: decision.messageId,
      claimAgeMs: decision.claimAgeMs,
      toleranceMs: decision.toleranceMs,
    });
    killContainer(session.id, 'claim-stuck');
    resetStuckProcessingRows(inDb, outDb, session, 'claim-stuck');
    return;
  }

  log.warn('Killing container — pending message waiting too long', {
    sessionId: session.id,
    oldestPendingAgeMs: decision.oldestPendingAgeMs,
    thresholdMs: decision.thresholdMs,
  });
  killContainer(session.id, 'pending-stuck');
  resetStuckProcessingRows(inDb, outDb, session, 'pending-stuck');
}

export function _resetStuckProcessingRowsForTesting(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
): void {
  resetStuckProcessingRows(inDb, outDb, session, reason, outDb);
}

function resetStuckProcessingRows(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
  writableOutDb?: Database.Database,
): void {
  const claims = getProcessingClaims(outDb);
  const now = Date.now();
  for (const { message_id } of claims) {
    const msg = getMessageForRetry(inDb, message_id, 'pending');
    if (!msg) continue;

    // Already rescheduled for a future retry — don't bump tries again. The
    // wake path (sweep step 2) will fire when process_after elapses and a
    // fresh container will clean the orphan claim on startup.
    if (msg.processAfter && parseSqliteUtc(msg.processAfter) > now) continue;

    if (msg.tries >= MAX_TRIES) {
      markMessageFailed(inDb, msg.id);
      log.warn('Message marked as failed after max retries', {
        messageId: msg.id,
        sessionId: session.id,
        reason,
      });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      retryWithBackoff(inDb, msg.id, backoffSec);
      log.info('Reset stale message with backoff', {
        messageId: msg.id,
        tries: msg.tries,
        backoffMs,
        reason,
      });
    }
  }

  // Drop the orphan 'processing' rows. Without this, the next sweep tick
  // would re-read them, see the old status_changed timestamp, conclude the
  // freshly respawned container is stuck, and SIGKILL it before its
  // agent-runner has a chance to run clearStaleProcessingAcks() on startup.
  const ownsDb = !writableOutDb;
  let useDb: Database.Database | null = writableOutDb ?? null;
  try {
    if (!useDb) useDb = openOutboundDbRw(session.agent_group_id, session.id);
    const cleared = deleteOrphanProcessingClaims(useDb);
    if (cleared > 0) {
      log.info('Cleared orphan processing claims', { sessionId: session.id, cleared, reason });
    }
  } catch (err) {
    log.warn('Failed to clear orphan processing claims', { sessionId: session.id, err });
  } finally {
    if (ownsDb) useDb?.close();
  }
}
