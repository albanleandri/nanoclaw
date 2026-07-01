import { isContainerRunning, killContainer } from '../container-runner.js';
import { getProcessingClaims, markMessageFailed } from '../db/session-db.js';
import { log } from '../log.js';
import { openInboundDb, openOutboundDb } from '../session-manager.js';
import {
  getOrchestrationRun,
  getStepAttempts,
  requestOrchestrationCancellation,
  type OrchestrationRun,
} from './run-store.js';

export function canCancelActiveAdapter(
  targetMessageId: string,
  processingMessageIds: string[],
  containerRunning: boolean,
): boolean {
  return containerRunning && processingMessageIds.length === 1 && processingMessageIds[0] === targetMessageId;
}

export function cancelOrchestrationExecution(input: { runId: string; agentGroupId?: string; reason?: string }): {
  run: OrchestrationRun;
  adapterCancellationRequested: boolean;
} {
  const existing = getOrchestrationRun(input.runId);
  if (!existing) throw new Error(`Orchestration run not found: ${input.runId}`);
  if (['succeeded', 'failed', 'cancelled'].includes(existing.status)) {
    const run = requestOrchestrationCancellation(input);
    return { run, adapterCancellationRequested: false };
  }
  const modelAttempt = getStepAttempts(input.runId)
    .filter((attempt) => attempt.kind === 'model')
    .sort((a, b) => b.attempt - a.attempt)[0];
  const run = requestOrchestrationCancellation(input);
  if (!modelAttempt?.input_message_id) return { run, adapterCancellationRequested: false };
  const executionSessionId = modelAttempt.execution_session_id ?? run.session_id;

  try {
    const inDb = openInboundDb(run.agent_group_id, executionSessionId);
    try {
      const status = (
        inDb.prepare('SELECT status FROM messages_in WHERE id = ?').get(modelAttempt.input_message_id) as
          | { status: string }
          | undefined
      )?.status;
      if (status === 'pending' || status === 'processing') {
        markMessageFailed(inDb, modelAttempt.input_message_id);
      }
    } finally {
      inDb.close();
    }
    // Cancellation remains durable even if a session DB has already been
    // removed or cannot be inspected.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    log.warn('Could not mark cancelled orchestration input failed', {
      runId: run.run_id,
      messageId: modelAttempt.input_message_id,
      err,
    });
  }

  let claims: string[] = [];
  try {
    const outDb = openOutboundDb(run.agent_group_id, executionSessionId);
    try {
      claims = getProcessingClaims(outDb).map((claim) => claim.message_id);
    } finally {
      outDb.close();
    }
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    log.warn('Could not inspect runner claims during orchestration cancellation', {
      runId: run.run_id,
      err,
    });
  }
  const shouldCancel = canCancelActiveAdapter(
    modelAttempt.input_message_id,
    claims,
    isContainerRunning(executionSessionId),
  );
  if (shouldCancel) {
    killContainer(executionSessionId, `orchestration-cancelled:${run.run_id}`);
  }
  return { run, adapterCancellationRequested: shouldCancel };
}
