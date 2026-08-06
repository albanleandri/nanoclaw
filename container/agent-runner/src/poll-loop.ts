import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import {
  getPendingMessages,
  markProcessing,
  markCompleted,
  markScriptSkipped,
  type MessageInRow,
} from './db/messages-in.js';
import { hasAppendLogRequestSince, maxSeq, writeMessageOut } from './db/messages-out.js';
import { getInboundDb, touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import {
  clearAuthFailureNotice,
  clearContinuation,
  clearProviderState,
  migrateLegacyContinuation,
  setContinuation,
  shouldNotifyAuthFailure,
} from './db/session-state.js';
import { clearCurrentInReplyTo, setCurrentInReplyTo } from './current-batch.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  isRunnerCommand,
  stripInternalTags,
  type RoutingContext,
} from './formatter.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderUsage } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;
const POST_RESULT_HEARTBEAT_MS = 10_000;
// Keep a completed provider stream warm briefly for follow-up messages, then
// let the runner exit so the host's global container limit cannot be consumed
// indefinitely by idle chat/task sessions. Continuations are persisted, so a
// later wake resumes the same provider conversation in a fresh container.
export const POST_RESULT_IDLE_EXIT_MS = 60_000;

/**
 * Number of consecutive `database disk image is malformed` errors after which
 * the follow-up poll gives up and exits the process. At ACTIVE_POLL_INTERVAL_MS
 * = 500ms this is roughly 5 seconds — long enough to dodge a transient torn
 * read during a host write, short enough to recover quickly from a poisoned
 * page cache (host-sweep then respawns with a fresh mount).
 */
const CORRUPTION_STREAK_EXIT = 10;

/**
 * True for SQLite errors that indicate a corrupt READ view — almost always a
 * cross-mount page-cache coherency issue on Docker Desktop macOS rather than
 * actual file damage (host-side integrity_check passes). Reopening the DB
 * handle inside this process does NOT recover; only a fresh container mount
 * does. Caller's job is to exit so host-sweep respawns the container.
 */
export function isCorruptionError(msg: string): boolean {
  return (
    msg.includes('database disk image is malformed') ||
    msg.includes('SQLITE_CORRUPT') ||
    msg.includes('file is not a database')
  );
}

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  /** Profile-scoped continuation key. Defaults to providerName for legacy config. */
  providerStateKey?: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
  stopSignal?: AbortSignal;
  /** Override for tests; production uses POST_RESULT_IDLE_EXIT_MS. */
  idleExitMs?: number;
}

export function runnerIdleExpired(idleSinceMs: number, nowMs: number, idleExitMs: number): boolean {
  return nowMs - idleSinceMs >= idleExitMs;
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  const providerStateKey = config.providerStateKey ?? config.providerName;
  let continuation: string | undefined = migrateLegacyContinuation(
    providerStateKey,
    providerStateKey === config.providerName,
  );

  // Before resuming, drop a session whose on-disk transcript has grown too
  // large/old to cold-resume within the host's idle ceiling. Without this a
  // long-lived hub keeps trying to reload an ever-growing .jsonl, hangs the
  // first turn, and gets killed before it can reply (then repeats forever).
  if (continuation) {
    const rotateReason = config.provider.maybeRotateContinuation?.(continuation, config.cwd);
    if (rotateReason) {
      log(`Rotating session — ${rotateReason}; starting fresh`);
      clearContinuation(providerStateKey);
      continuation = undefined;
    }
  }

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  let isFirstPoll = true;
  let idleSinceMs = Date.now();
  const idleExitMs = config.idleExitMs ?? POST_RESULT_IDLE_EXIT_MS;
  while (!config.stopSignal?.aborted) {
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages(isFirstPoll).filter((m) => m.kind !== 'system');
    isFirstPoll = false;
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      if (runnerIdleExpired(idleSinceMs, Date.now(), idleExitMs)) {
        log(`Runner idle window expired after ${idleExitMs}ms; releasing container slot`);
        return;
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
    if (!messages.some((m) => m.trigger === 1)) {
      if (runnerIdleExpired(idleSinceMs, Date.now(), idleExitMs)) {
        log(`Runner idle window expired with context-only rows after ${idleExitMs}ms; releasing container slot`);
        return;
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    idleSinceMs = Date.now();

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    const routing = extractRouting(messages);

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearContinuation(providerStateKey);
        clearProviderState(providerStateKey);
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      normalMessages.push(msg);
    }

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: Array<{ id: string; reason: string }> = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markScriptSkipped(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.map((s) => s.id).join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    // Format messages: known native/admin commands get raw text (only if
    // the provider natively handles slash commands), others get XML.
    const prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    const query = config.provider.query({
      prompt,
      continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
    });

    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped.map((s) => s.id));
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
    const orchestrationIds = orchestrationMessageIds(keep);
    // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
    // can stamp it on outbound rows — needed for a2a return-path routing.
    setCurrentInReplyTo(routing.inReplyTo);
    let orchestrationResult: QueryResult | undefined;
    let orchestrationException = false;
    let orchestrationResultWritten = false;
    const persistInitialBatchResult = (result: QueryResult): void => {
      if (orchestrationResultWritten) return;
      writeOrchestrationResult(orchestrationIds, result.outcome, result.usage, result.error);
      orchestrationResultWritten = true;
    };
    try {
      const result = await processQuery(query, routing, processingIds, providerStateKey, {
        stopSignal: config.stopSignal,
        onInitialBatchTerminal: persistInitialBatchResult,
      });
      orchestrationResult = result;
      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(providerStateKey, continuation);
      }
      if (result.idleExpired) {
        log('Provider stream idle; exiting runner for fair container-slot reuse');
        return;
      }
    } catch (err) {
      orchestrationException = true;
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);

      // Persist the terminal fact before writing the user-facing error. The
      // host reads outbound rows in sequence and gates correlated chat output
      // on this fact, so reversing the order adds an avoidable delivery-poll
      // delay and can recreate the result/stream lifecycle deadlock.
      if (!orchestrationResultWritten) {
        writeOrchestrationResult(orchestrationIds, 'exception');
        orchestrationResultWritten = true;
      }

      // Stale/corrupt continuation recovery: ask the provider whether
      // this error means the stored continuation is unusable, and clear
      // it so the next attempt starts fresh.
      if (continuation && config.provider.isSessionInvalid(err)) {
        log(`Stale session detected (${continuation}) — clearing for next retry`);
        continuation = undefined;
        clearContinuation(providerStateKey);
      }

      // Write error response so the user knows something went wrong
      writeMessageOut({
        id: generateId(),
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: `Error: ${errMsg}` }),
      });
      log(`Errored batch will be acked completed — ${processingIds.length} message(s), no redelivery`);
    } finally {
      clearCurrentInReplyTo();
    }
    if (!orchestrationResultWritten) {
      writeOrchestrationResult(
        orchestrationIds,
        orchestrationException ? 'exception' : (orchestrationResult?.outcome ?? 'interrupted'),
        orchestrationResult?.usage,
        orchestrationResult?.error,
      );
    }

    // Safety net: processQuery completes the batch in every terminal branch
    // (result, terminal-error, silent-close). This idempotent call also covers
    // the throw path above, where processQuery exited via exception.
    markCompleted(processingIds);
    log(`Completed ${ids.length} message(s)`);
  }
}

/**
 * Format messages, handling known native/admin commands differently.
 *
 * Unknown slash commands are skill/application triggers, not Claude Code
 * commands. They must stay XML-wrapped so the agent can interpret them from
 * its instructions instead of the SDK rejecting them before the model runs.
 */
export function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively.
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

/**
 * How the initial batch's turn ended.
 * - 'result' — the provider produced a result for the initial batch.
 * - 'terminal-error' — a quota/auth/non-retryable error was surfaced and the batch completed.
 * - 'silent-close' — the stream ended with no terminal event; processQuery surfaced an error.
 * - 'interrupted' — a runner command or host stop ended the stream; recovery belongs to the caller.
 */
type InitialBatchOutcome = 'result' | 'terminal-error' | 'silent-close' | 'interrupted';

interface QueryResult {
  continuation?: string;
  outcome: InitialBatchOutcome;
  idleExpired?: boolean;
  usage?: ProviderUsage;
  error?: {
    classification: string;
    retryable: boolean;
    sideEffectBoundaryCrossed: boolean | null;
  };
}

export function writeOrchestrationResult(
  inputMessageIds: string[],
  outcome: InitialBatchOutcome | 'exception',
  usage?: ProviderUsage,
  error?: QueryResult['error'],
): void {
  if (inputMessageIds.length === 0) return;
  const eventId = `orchestration-result:${generateId()}`;
  writeMessageOut({
    id: eventId,
    kind: 'system',
    content: JSON.stringify({
      action: 'orchestration_result',
      eventId,
      inputMessageIds,
      outcome,
      usage,
      error,
      createdAt: new Date().toISOString(),
    }),
  });
}

export function orchestrationMessageIds(messages: Array<Pick<MessageInRow, 'id' | 'orchestration_run_id'>>): string[] {
  return messages.filter((message) => message.orchestration_run_id != null).map((message) => message.id);
}

interface ProcessQueryOptions {
  touchHeartbeat?: () => void;
  postResultHeartbeatMs?: number;
  postResultIdleExitMs?: number;
  activePollIntervalMs?: number;
  stopSignal?: AbortSignal;
  getPendingMessages?: typeof getPendingMessages;
  markProcessing?: typeof markProcessing;
  markCompleted?: typeof markCompleted;
  onInitialBatchTerminal?: (result: QueryResult) => void;
}

export async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  opts: ProcessQueryOptions = {},
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let initialBatchResolved = false;
  let outcome: InitialBatchOutcome | undefined;
  let done = false;
  let unwrappedNudged = false;
  // Once-per-turn guard for the task-fire "<message> block was not delivered"
  // nudge — mirrors unwrappedNudged for chat turns.
  let taskBlockNudged = false;
  let providerFailureNotified = false;
  let initialTurnCompleted = false;
  let usage: ProviderUsage | undefined;
  let terminalError: QueryResult['error'];
  let lastPostResultHeartbeat = 0;
  let lastPostResultActivity = 0;
  let idleExpired = false;
  let followUpsInFlight = 0;
  const heartbeat = opts.touchHeartbeat ?? touchHeartbeat;
  const readPendingMessages = opts.getPendingMessages ?? getPendingMessages;
  const claimMessages = opts.markProcessing ?? markProcessing;
  const completeMessages = opts.markCompleted ?? markCompleted;
  const postResultHeartbeatMs = opts.postResultHeartbeatMs ?? POST_RESULT_HEARTBEAT_MS;
  const postResultIdleExitMs = opts.postResultIdleExitMs ?? POST_RESULT_IDLE_EXIT_MS;
  const activePollIntervalMs = opts.activePollIntervalMs ?? ACTIVE_POLL_INTERVAL_MS;
  const resolveInitialBatch = (
    resolvedOutcome: Exclude<InitialBatchOutcome, 'interrupted'>,
    resolvedUsage?: ProviderUsage,
    resolvedError?: QueryResult['error'],
  ): void => {
    if (initialBatchResolved) return;
    initialBatchResolved = true;
    outcome = resolvedOutcome;
    usage = resolvedUsage;
    terminalError = resolvedError;
    completeMessages(initialBatchIds);
    opts.onInitialBatchTerminal?.({
      continuation: queryContinuation,
      outcome: resolvedOutcome,
      usage: resolvedUsage,
      error: resolvedError,
    });
  };
  const abortQuery = () => {
    done = true;
    query.abort();
  };
  opts.stopSignal?.addEventListener('abort', abortQuery, { once: true });

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl
  // transcript on every turn. The Anthropic prompt cache is server-side with
  // a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect
  // cache lifetime — close+reopen within 5 min still gets cache hits.
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  let pollInFlight = false;
  let endedForCommand = false;
  let corruptionStreak = 0;
  const pollHandle = setInterval(() => {
    if (done || pollInFlight || endedForCommand) return;
    pollInFlight = true;

    void (async () => {
      try {
        if (initialTurnCompleted) {
          const now = Date.now();
          if (now - lastPostResultHeartbeat >= postResultHeartbeatMs) {
            heartbeat();
            lastPostResultHeartbeat = now;
          }
        }

        const pending = readPendingMessages();

        // Known native/admin slash commands need a fresh query: /clear resets
        // the SDK's resume id (fixed at sdkQuery() time), and commands such
        // as /compact or /cost only dispatch when they're the first input of
        // a query. End the stream and leave the rows
        // pending; the outer loop handles them on next iteration via the
        // canonical command path + formatMessagesWithCommands.
        if (pending.some((m) => isRunnerCommand(m))) {
          log('Pending slash command — ending stream so outer loop can process');
          endedForCommand = true;
          query.end();
          return;
        }

        // Skip system messages (MCP tool responses).
        // Thread routing is the router's concern — if a message landed in this
        // session, the agent should see it. Per-thread sessions already isolate
        // threads into separate containers; shared sessions intentionally merge
        // everything. Filtering on thread_id here caused deadlocks when the
        // initial batch and follow-ups had mismatched thread_ids (e.g. a
        // host-generated welcome trigger with null thread vs a Discord DM reply).
        const newMessages = pending.filter((m) => m.kind !== 'system');
        if (newMessages.length === 0) {
          if (
            initialTurnCompleted &&
            followUpsInFlight === 0 &&
            Date.now() - lastPostResultActivity >= postResultIdleExitMs
          ) {
            idleExpired = true;
            log(`Post-result idle window expired after ${postResultIdleExitMs}ms; releasing container slot`);
            query.end();
          }
          return;
        }

        const newIds = newMessages.map((m) => m.id);
        lastPostResultActivity = Date.now();
        claimMessages(newIds);

        // Run pre-task scripts on follow-ups too — without this, a task that
        // arrives during an active query (e.g. a */10 monitoring cron) bypasses
        // its script gate and always wakes the agent, defeating the gate.
        // Mirrors the initial-batch hook above.
        let keep = newMessages;
        let skipped: Array<{ id: string; reason: string }> = [];
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          markScriptSkipped(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.map((s) => s.id).join(', ')}`);
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        if (keep.length === 0) return;
        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work; the
        // claimed messages get released by the host's processing-claim sweep.
        if (done) return;

        const keptIds = keep.map((m) => m.id);
        const keptOrchestrationIds = orchestrationMessageIds(keep);
        const prompt = formatMessages(keep);
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        unwrappedNudged = false;
        taskBlockNudged = false;
        followUpsInFlight += 1;
        try {
          query.push(prompt, () => {
            writeOrchestrationResult(keptOrchestrationIds, 'result');
            completeMessages(keptIds);
            followUpsInFlight = Math.max(0, followUpsInFlight - 1);
            lastPostResultActivity = Date.now();
          });
        } catch (err) {
          followUpsInFlight = Math.max(0, followUpsInFlight - 1);
          throw err;
        }
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);

        // Detect SQLite cross-mount corruption (Docker Desktop macOS virtiofs /
        // gRPC-FUSE coherency bug — the kernel page cache for the inbound.db
        // bind mount can latch a torn snapshot mid-host-write, after which
        // every fresh openInboundDb() in this process sees the same broken
        // view. Reopening inside the container does NOT recover; only a fresh
        // container mount does. Exit so the host sweep respawns us.
        if (isCorruptionError(errMsg)) {
          corruptionStreak += 1;
          if (corruptionStreak >= CORRUPTION_STREAK_EXIT) {
            log(
              `Follow-up poll: ${corruptionStreak} consecutive '${errMsg}' errors — ` +
                `inbound.db page cache is poisoned. Exiting so host respawns with a fresh mount.`,
            );
            // Stop touching the heartbeat so host-sweep stale detection fires
            // promptly even if exit() races with in-flight async work.
            done = true;
            clearInterval(pollHandle);
            // Defer exit one tick so this log line flushes through Docker's
            // log driver before the process dies.
            setTimeout(() => process.exit(75), 100);
          }
        } else {
          corruptionStreak = 0;
        }
      } finally {
        pollInFlight = false;
      }
    })();
  }, activePollIntervalMs);

  // Seq watermark before the agent runs — anything after this is "this fire"
  // for the append-log exactly-once guard.
  const turnStartSeq = maxSeq();

  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
      heartbeat();

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        setContinuation(providerName, event.continuation);
      } else if (event.type === 'error' && event.classification === 'quota') {
        const error = {
          classification: event.classification,
          retryable: event.retryable,
          sideEffectBoundaryCrossed: event.sideEffectBoundaryCrossed ?? null,
        };
        // Anthropic usage/rate limit — notify the user and stop this turn.
        // The container cannot retry (the limit is account-wide), so there is
        // no value in keeping the stream open. Mark messages completed so the
        // host sweep does not reset them to pending and immediately re-wake.
        resolveInitialBatch('terminal-error', undefined, error);
        writeUsageLimitNotification(routing);
        break;
      } else if (event.type === 'error' && event.classification === 'auth') {
        if (initialBatchResolved) {
          log('Ignoring late authentication error from an already-completed persistent query');
          query.end();
          break;
        }
        const error = {
          classification: event.classification,
          retryable: event.retryable,
          sideEffectBoundaryCrossed: event.sideEffectBoundaryCrossed ?? null,
        };
        // Credential/auth failure (e.g. an expired shared OAuth token reaching
        // the container as a 401). The container cannot fix this itself, and a
        // tight retry would just re-hit the same dead credential — so mark the
        // batch completed (no re-wake storm) but SURFACE the failure to the
        // user instead of finishing silently.
        resolveInitialBatch('terminal-error', undefined, error);
        writeAuthErrorNotification(routing);
        break;
      } else if (event.type === 'error' && !event.retryable) {
        const error = {
          classification: event.classification ?? 'unknown',
          retryable: event.retryable,
          sideEffectBoundaryCrossed: event.sideEffectBoundaryCrossed ?? null,
        };
        resolveInitialBatch('terminal-error', undefined, error);
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({
            text: `⚠️ Provider error${event.classification ? ` (${event.classification})` : ''}: ${event.message}`,
          }),
        });
        break;
      } else if (event.type === 'result') {
        // A result — with or without text — means the turn is done. Mark
        // the initial batch completed now so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for
        // follow-up pushes. The agent may have responded via MCP
        // (send_message) mid-turn, or the message may not need a response
        // at all — either way the turn is finished.
        resolveInitialBatch('result', event.usage);
        initialTurnCompleted = true;
        lastPostResultHeartbeat = Date.now();
        lastPostResultActivity = lastPostResultHeartbeat;
        if (event.text) {
          if (isBareProviderUsageLimitError(event.text)) {
            if (!providerFailureNotified) {
              providerFailureNotified = true;
              writeUsageLimitNotification(routing);
            }
            query.end();
            break;
          }

          if (isBareProviderAuthError(event.text)) {
            // The provider surfaced a bare authentication error as result text
            // (e.g. an expired/invalid credential). Without this the text would
            // be treated as unwrapped scratchpad and the user would get
            // silence. Tell them instead, then stop the turn.
            if (!providerFailureNotified) {
              providerFailureNotified = true;
              writeAuthErrorNotification(routing);
            }
            query.end();
            break;
          }

          clearAuthFailureNotice();
          const { sent, hasUnwrapped, taskBlocks } = dispatchResultText(event.text, routing);
          const willRetryTaskBlocks = shouldNudgeTaskBlocks(routing.taskFire === true, taskBlocks, taskBlockNudged);
          // One-door task delivery: the final text becomes the run log entry
          // (guarded — an explicit append-log this fire wins). Errors included:
          // a failed fire's text belongs in the run log, not in a chat.
          // When we nudge on inert <message> blocks, DEFER the append to the
          // retry's result so the fire logs exactly once.
          if (routing.taskFire && !willRetryTaskBlocks) autoAppendTaskLog(event.text, turnStartSeq);
          if (sent === 0 && event.isError === true && !routing.taskFire) {
            deliverErrorResult(event.text, routing);
            query.end();
            break;
          }

          if (hasUnwrapped && !unwrappedNudged) {
            unwrappedNudged = true;
            const destinations = getAllDestinations();
            const names = destinations.map((d) => d.name).join(', ');
            query.push(
              `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
                `All output must be wrapped: use <message to="name"> for content to send, or <internal> for scratchpad. ` +
                `Your destinations: ${names}. ` +
                `Please re-send your response with the correct wrapping.</system>`,
            );
          }

          if (willRetryTaskBlocks) {
            taskBlockNudged = true;
            const names = getAllDestinations()
              .map((d) => d.name)
              .join(', ');
            query.push(
              `<system>Your <message> block was NOT delivered — task sessions deliver only via the send_message tool. ` +
                `Re-send now with send_message({to: "<name>", ...}). Your destinations: ${names}.</system>`,
            );
          }
        } else {
          clearAuthFailureNotice();
        }
      }
    }
  } finally {
    opts.stopSignal?.removeEventListener('abort', abortQuery);
    done = true;
    clearInterval(pollHandle);
  }

  const interrupted = endedForCommand || (opts.stopSignal?.aborted ?? false);
  if (!initialBatchResolved && !interrupted) {
    // A provider stream that ends without a result or terminal error violates
    // the provider contract. Surface that failure and complete the batch so
    // the message is neither lost silently nor stuck processing in a live
    // container.
    resolveInitialBatch('silent-close');
    writeMessageOut({
      id: generateId(),
      kind: 'chat',
      platform_id: routing.platformId,
      channel_type: routing.channelType,
      thread_id: routing.threadId,
      content: JSON.stringify({
        text: '⚠️ The model provider ended the turn without producing a response. Please try again.',
      }),
    });
  }

  return {
    continuation: queryContinuation,
    outcome: outcome ?? 'interrupted',
    idleExpired,
    usage,
    error: terminalError,
  };
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
  }
}

function deliverErrorResult(text: string, routing: RoutingContext): void {
  log('Error result with no <message> envelope — delivering to channel');
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text }),
  });
}

function writeUsageLimitNotification(routing: RoutingContext): void {
  writeMessageOut({
    id: generateId(),
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({
      text: "Usage limit reached. I can't process requests right now. Try again later.",
    }),
  });
}

function isBareProviderUsageLimitError(text: string): boolean {
  const trimmed = stripInternalTags(text).trim();
  return (
    /^api error:/i.test(trimmed) &&
    /(429|rate limit|usage limit|exceed\w* your account.*limit|request rejected)/i.test(trimmed)
  );
}

function writeAuthErrorNotification(routing: RoutingContext): void {
  if (!shouldNotifyAuthFailure()) {
    log('Authentication failure notification suppressed by session cooldown');
    return;
  }
  writeMessageOut({
    id: generateId(),
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({
      text:
        "⚠️ I couldn't reach Claude — authentication failed (my login may have expired). " +
        'Your message was not processed. Please re-login on the host (run `claude` / `/login`) and try again.',
    }),
  });
}

// A bare authentication error surfaced as provider result text (mirrors
// isBareProviderUsageLimitError). Anthropic returns 401 with an
// `authentication_error` body when the credential is missing/expired/invalid.
function isBareProviderAuthError(text: string): boolean {
  const trimmed = stripInternalTags(text).trim();
  return (
    /^api error:/i.test(trimmed) &&
    /(401|unauthorized|authentication[_ ]error|invalid x-api-key|invalid bearer token|oauth(?: access)? token (has )?expired|could not resolve authentication)/i.test(
      trimmed,
    )
  );
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is scratchpad — logged but not sent.
 *
 * The agent must always wrap output in <message to="name">...</message>
 * blocks, even with a single destination. Bare text is scratchpad only.
 */
export function dispatchResultText(
  text: string,
  routing: RoutingContext,
): { sent: number; hasUnwrapped: boolean; taskBlocks: number } {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  // <message to> blocks left inert in a task fire — drives the same-turn
  // "use send_message" nudge in processQuery.
  let taskBlocks = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = stripInternalTags(match[2]).trim();
    lastIndex = MESSAGE_RE.lastIndex;
    if (!body) {
      continue;
    }

    // One-door delivery in task sessions: only the send_message tool delivers.
    // A final-text <message to> block here is either an echo of a tool send the
    // agent already made (the double-delivery class) or a send down the wrong
    // path — never deliver it, keep it visible in the scratchpad/run log.
    if (routing.taskFire) {
      log(`Task fire: <message to="${toName}"> block not delivered — task sessions send only via send_message`);
      scratchpadParts.push(`[not delivered — task sessions send only via the send_message tool; to="${toName}"] ${body}`);
      taskBlocks++;
      continue;
    }

    const dest = resolveMessageDestination(toName, routing);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const scratchpad = stripInternalTags(scratchpadParts.join(''));

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  // In a task fire, plain final text is the NORMAL ending (it becomes the run
  // log) — never treat it as an undelivered reply or nudge the agent to wrap it.
  const hasUnwrapped = !routing.taskFire && sent === 0 && !!scratchpad;
  if (hasUnwrapped) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
  return { sent, hasUnwrapped, taskBlocks };
}

/**
 * Should this task-fire result get the same-turn "your <message> block was
 * not delivered — use send_message" nudge? True at most once per turn
 * (mirrors the unwrappedNudged flag for chat turns). While true, the run-log
 * auto-append is DEFERRED to the retry's result so the fire logs exactly once.
 */
export function shouldNudgeTaskBlocks(taskFire: boolean, taskBlocks: number, alreadyNudged: boolean): boolean {
  return taskFire && taskBlocks > 0 && !alreadyNudged;
}

/**
 * Task fires: the final text IS the run log entry, unless the agent already
 * logged this fire explicitly via `ncl tasks append-log` (exactly-once guard —
 * old tasks whose baked-in prompt still mandates append-log don't double-log).
 * Written as a `task_log` outbound row; the host appends it to the series'
 * tasks/<id>.md with its usual timestamp stamp. Never delivered to anyone.
 */
export function autoAppendTaskLog(text: string, turnStartSeq: number): void {
  // Run-log hygiene: an inert <message to> block never belongs in the log as
  // raw XML — replace each with its inner text, marked undelivered, so the
  // log stays readable prose.
  const prose = text.replace(
    /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g,
    (_m, to: string, body: string) => `[undelivered → ${to}] ${body.trim()}`,
  );
  const line = stripInternalTags(prose).replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!line) return;
  if (hasAppendLogRequestSince(turnStartSeq)) {
    log('Task fire already logged via append-log — skipping final-text auto-log');
    return;
  }
  writeMessageOut({
    id: generateId(),
    kind: 'task_log',
    content: JSON.stringify({ text: line }),
  });
  log('Task fire run log auto-appended from final text');
}

function resolveMessageDestination(toName: string, routing: RoutingContext): DestinationEntry | undefined {
  const configured = findByName(toName);
  if (configured) return configured;

  const fallback = parseUnknownDestinationName(toName);
  if (!fallback) return undefined;
  if (fallback.channelType !== routing.channelType || fallback.platformId !== routing.platformId) return undefined;

  return {
    name: toName,
    displayName: toName,
    type: 'channel',
    channelType: fallback.channelType,
    platformId: fallback.platformId,
  };
}

function parseUnknownDestinationName(name: string): { channelType: string; platformId: string } | null {
  const prefix = 'unknown:';
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  const separator = rest.indexOf(':');
  if (separator <= 0 || separator === rest.length - 1) return null;
  return {
    channelType: rest.slice(0, separator),
    platformId: rest.slice(separator + 1),
  };
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  const destRouting = resolveDestinationThread(channelType, platformId);
  writeMessageOut({
    id: generateId(),
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ text: body }),
  });
}

/**
 * Find the thread_id and message id from the most recent inbound message
 * matching the given channel+platform. Returns null if no match found.
 */
function resolveDestinationThread(
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: string | null } | null {
  try {
    const db = getInboundDb();
    const row = db
      .prepare(
        `SELECT thread_id, id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { thread_id: string | null; id: string } | undefined;
    if (row) return { threadId: row.thread_id, inReplyTo: row.id };
  } catch (err) {
    log(`resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
