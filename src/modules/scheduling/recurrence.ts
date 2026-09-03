/**
 * Sweep hook for recurring tasks.
 *
 * Every sweep tick, find `messages_in` rows that are `completed` AND still
 * have a `recurrence` cron expression. For each, compute the next run via
 * cron-parser, insert a fresh pending row (copying series_id forward), then
 * clear the recurrence on the original so it isn't re-cloned next tick.
 *
 * Called from `src/host-sweep.ts` inside `MODULE-HOOK:scheduling-recurrence`.
 * When scheduling ships inline (current state through PR #7), the hook is a
 * direct dynamic import. When scheduling moves to the modules branch in
 * PR #8, the install skill re-fills the marker on install.
 */
import type Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../../config.js';
import { getRetryableTaskErrorAcks } from '../../db/session-db.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { clearRecurrence, getCompletedRecurring, insertRecurrence, trailingFailedRuns } from './db.js';
import { appendRunLog } from './run-log.js';

// Consecutive failed runs (the series' trailing FAILED occurrences — derived
// from occurrence rows, no stored counter) throttle a series that cannot
// succeed instead of letting it wake a container at raw cron cadence forever.
// Both causes count: a broken pre-task gate script, and a provider the agent
// could not reach. A deliberate wakeAgent=false gate is a normal completed run
// and never backs off. Mirrors the stuck-message retry in host-sweep.ts
// (BACKOFF_BASE_MS doubling, MAX_TRIES → failed): fail loud, don't spin.
const FAIL_PAUSE_CAP = 8;
const BACKOFF_CAP_MIN = 60;

/** 2, 4, 8, 16, 32, 60, 60… minutes for fails = 1, 2, 3… */
export function failureBackoffMinutes(fails: number): number {
  return Math.min(2 * 2 ** (fails - 1), BACKOFF_CAP_MIN);
}

/** Operator-facing cause of a re-armed failed occurrence. */
type FailureCause = 'script' | 'provider';

function describeFailure(cause: FailureCause): string {
  return cause === 'provider' ? 'provider unreachable (credential or quota)' : 'pre-task script error';
}

function describeRemedy(cause: FailureCause): string {
  return cause === 'provider' ? 'restore provider access' : 'fix the script';
}

/** Host-written line in the series run log — no agent session exists to call
 *  append-log when a script-gated series is auto-paused. Uses the shared
 *  appendRunLog helper (one writer format); appendRunLog throws on a bad
 *  series charset or a missing agent group, and the sweep must not crash
 *  over a log line, so failures are logged and swallowed. */
function appendHostTaskNote(agentGroupId: string, seriesId: string, note: string): void {
  try {
    appendRunLog(agentGroupId, seriesId, note);
  } catch (err) {
    log.warn('Could not append host task note to run log', { agentGroupId, seriesId, err });
  }
}

export async function handleRecurrence(
  inDb: Database.Database,
  session: Session,
  outDb: Database.Database | null = null,
): Promise<void> {
  // Cause per re-armable failed ack. The key set is the re-arm gate; the value
  // is what the operator reads in the run log.
  const failureCauses = outDb ? getRetryableTaskErrorAcks(outDb) : new Map<string, FailureCause>();
  const recurring = getCompletedRecurring(inDb, new Set(failureCauses.keys()));

  for (const msg of recurring) {
    try {
      // Interpret the cron expression in the user's timezone. v1 did this
      // (src/v1/task-scheduler.ts:20-49); without it, a task written "0 9 * * *"
      // by an agent running in a user's local TZ fires at 09:00 UTC instead of
      // 09:00 user-local.
      const interval = CronExpressionParser.parse(msg.recurrence, { tz: TIMEZONE });
      const cronNext = interval.next().toDate();
      // getCompletedRecurring only ever returns task rows now (RecurringMessage
      // no longer carries `kind` — see db.ts), so the id prefix is always 'task'.
      const newId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const failedRuns = trailingFailedRuns(inDb, msg.series_id ?? msg.id);
      // Cause of THIS occurrence (the streak behind it can be mixed). Set only
      // when the occurrence being re-armed is itself a failure.
      const cause = failureCauses.get(msg.id);

      if (failedRuns >= FAIL_PAUSE_CAP) {
        // Re-arm PAUSED at the cron time so `ncl tasks resume` revives the
        // series in place; leave the why in the run log.
        insertRecurrence(inDb, msg, newId, cronNext.toISOString(), 'paused');
        clearRecurrence(inDb, msg.id);
        const remedy = cause ? describeRemedy(cause) : 'fix the underlying failure';
        appendHostTaskNote(
          session.agent_group_id,
          msg.series_id,
          `auto-paused after ${failedRuns} consecutive failed runs (host)${cause ? `; last failure: ${describeFailure(cause)}` : ''}; ${remedy}, then \`ncl tasks resume ${msg.series_id}\``,
        );
        log.warn('Task series auto-paused: runs keep failing', {
          seriesId: msg.series_id,
          failedRuns,
          cause: cause ?? 'unknown',
          sessionId: session.id,
        });
        continue;
      }

      const backoffAt = failedRuns > 0 ? Date.now() + failureBackoffMinutes(failedRuns) * 60_000 : 0;
      const nextRun = new Date(Math.max(cronNext.getTime(), backoffAt)).toISOString();

      insertRecurrence(inDb, msg, newId, nextRun);
      clearRecurrence(inDb, msg.id);

      // The run log is the series' durable history, and a failed fire writes
      // nothing to it on its own — the runner's auto-append only covers a turn
      // that produced result text, which a credential or quota failure never
      // does. Without this line the operator sees an unexplained gap where the
      // occurrence should be.
      if (cause) {
        appendHostTaskNote(
          session.agent_group_id,
          msg.series_id,
          `run failed (${describeFailure(cause)}); failure ${failedRuns} in a row, next attempt ${nextRun}`,
        );
      }

      log.info('Inserted next recurrence', {
        originalId: msg.id,
        newId,
        seriesId: msg.series_id,
        nextRun,
        ...(failedRuns > 0 && { failedRuns, backoffMin: failureBackoffMinutes(failedRuns) }),
        ...(cause && { cause }),
        sessionId: session.id,
      });
    } catch (err) {
      log.error('Failed to compute next recurrence', {
        messageId: msg.id,
        recurrence: msg.recurrence,
        err,
      });
    }
  }
}
