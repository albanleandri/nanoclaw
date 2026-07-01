import type Database from 'better-sqlite3';

import type { ModelUsage } from '../auxiliary/types.js';
import { registerDeliveryAction } from '../delivery.js';
import { log } from '../log.js';
import type { Session } from '../types.js';
import { maybeDispatchFallback } from './fallback-dispatcher.js';
import { recordModelBatchResult } from './run-store.js';

function usage(value: unknown): ModelUsage | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid orchestration usage');
  const raw = value as Record<string, unknown>;
  const result: Partial<ModelUsage> = {};
  for (const field of ['inputTokens', 'outputTokens', 'cachedTokens', 'estimatedCostUsd'] as const) {
    const item = raw[field];
    if (item !== undefined && (typeof item !== 'number' || !Number.isFinite(item) || item < 0)) {
      throw new Error(`Invalid orchestration usage ${field}`);
    }
    if (typeof item === 'number') result[field] = item;
  }
  if (!['provider', 'estimated', 'unknown'].includes(String(raw.source))) {
    throw new Error('Invalid orchestration usage source');
  }
  return { ...result, source: raw.source as ModelUsage['source'] };
}

function fallbackError(
  value: unknown,
): { classification: string; retryable: boolean; sideEffectBoundaryCrossed: boolean | null } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid orchestration error facts');
  const raw = value as Record<string, unknown>;
  if (typeof raw.classification !== 'string' || raw.classification.length === 0 || raw.classification.length > 100) {
    throw new Error('Invalid orchestration error classification');
  }
  if (typeof raw.retryable !== 'boolean') throw new Error('Invalid orchestration error retryable flag');
  if (raw.sideEffectBoundaryCrossed !== null && typeof raw.sideEffectBoundaryCrossed !== 'boolean') {
    throw new Error('Invalid orchestration side-effect boundary');
  }
  return {
    classification: raw.classification,
    retryable: raw.retryable,
    sideEffectBoundaryCrossed: raw.sideEffectBoundaryCrossed as boolean | null,
  };
}

export async function handleOrchestrationResult(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const eventId = String(content.eventId ?? '');
  if (!eventId.startsWith('orchestration-result:') || eventId.length > 256) {
    throw new Error('Invalid orchestration result event ID');
  }
  if (!Array.isArray(content.inputMessageIds) || content.inputMessageIds.length > 100) {
    throw new Error('Invalid orchestration input message IDs');
  }
  const inputMessageIds = content.inputMessageIds.map(String);
  if (inputMessageIds.some((id) => id.length === 0 || id.length > 512)) {
    throw new Error('Invalid orchestration input message ID');
  }
  const outcome = String(content.outcome);
  if (!['result', 'terminal-error', 'silent-close', 'interrupted', 'exception'].includes(outcome)) {
    throw new Error('Invalid orchestration outcome');
  }
  const completed = recordModelBatchResult({
    eventId,
    sourceSessionId: session.id,
    inputMessageIds,
    outcome: outcome as Parameters<typeof recordModelBatchResult>[0]['outcome'],
    usage: usage(content.usage),
    error: fallbackError(content.error),
    createdAt: typeof content.createdAt === 'string' ? content.createdAt : new Date().toISOString(),
  });
  for (const attempt of completed) {
    if (attempt.status !== 'failed') continue;
    try {
      await maybeDispatchFallback(attempt);
      // Result persistence must survive a candidate dispatch failure.
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (err) {
      log.warn('Fallback dispatch failed; recovery sweep may retry', {
        runId: attempt.run_id,
        attemptId: attempt.attempt_id,
        err,
      });
    }
  }
}

registerDeliveryAction('orchestration_result', handleOrchestrationResult);
