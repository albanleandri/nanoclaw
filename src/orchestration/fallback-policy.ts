import { createHash } from 'crypto';

import type { ProviderProtocol } from '../providers/provider-descriptor.js';
import type { AgentRuntimeKind, RuntimeStateSemantics } from '../providers/runtime-descriptor.js';
import { advancedFeatureEnabled, type AdvancedFeaturePolicy } from './advanced-feature-policy.js';
import type { TaskAssessment } from './types.js';

export type FallbackFailureClass =
  | 'transient'
  | 'rate_limit'
  | 'unavailable'
  | 'auth'
  | 'quota'
  | 'invalid_request'
  | 'context'
  | 'tool_execution'
  | 'unknown';

export interface FallbackAttemptFacts {
  runtimeKind: AgentRuntimeKind;
  protocol: ProviderProtocol;
  continuation: RuntimeStateSemantics['continuation'];
  capabilityFingerprint: string;
  toolSchemaFingerprint: string;
  inputReconstructable: boolean;
  sideEffectBoundaryCrossed: boolean | null;
  resultEmitted: boolean;
  artifactEmitted: boolean;
  deliveryEmitted: boolean;
}

export interface FallbackCandidate {
  id: string;
  runtimeKind: AgentRuntimeKind;
  protocol: ProviderProtocol;
  continuation: RuntimeStateSemantics['continuation'];
  capabilityFingerprint: string;
  toolSchemaFingerprint: string;
  credentialsAvailable: boolean;
}

export interface FallbackDecisionInput {
  policy: AdvancedFeaturePolicy;
  taskClass: TaskAssessment['taskClass'];
  role: 'main' | 'auxiliary-read-only';
  failure: { classification: FallbackFailureClass; retryable: boolean };
  attempt: FallbackAttemptFacts;
  candidate: FallbackCandidate;
  budget: {
    nextAttempt: number;
    elapsedMs: number;
    usedTokens: number;
    estimatedCostUsd: number;
  };
}

export interface FallbackDecision {
  allowed: boolean;
  candidateId: string;
  policyVersion: string;
  reasons: string[];
}

const ALLOWED_FAILURES = new Set<FallbackFailureClass>(['transient', 'rate_limit', 'unavailable']);

export function stableFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function evaluateFallback(input: FallbackDecisionInput): FallbackDecision {
  const reasons: string[] = [];
  if (!advancedFeatureEnabled(input.policy, 'fallback')) reasons.push('feature_disabled');
  if (!input.policy.allowedTaskClasses.includes(input.taskClass)) reasons.push('task_class_denied');
  if (!ALLOWED_FAILURES.has(input.failure.classification)) {
    reasons.push('failure_not_eligible');
  }
  if (input.attempt.runtimeKind !== 'protocol-loop') reasons.push('native_harness_migration_denied');
  if (input.attempt.continuation === 'runtime-thread') reasons.push('native_continuation_denied');
  if (!input.attempt.inputReconstructable) reasons.push('input_not_reconstructable');
  if (input.attempt.sideEffectBoundaryCrossed !== false) reasons.push('side_effect_state_not_clean');
  if (input.attempt.resultEmitted) reasons.push('result_already_emitted');
  if (input.attempt.artifactEmitted) reasons.push('artifact_already_emitted');
  if (input.attempt.deliveryEmitted) reasons.push('delivery_already_emitted');
  if (input.candidate.runtimeKind !== 'protocol-loop') reasons.push('candidate_not_protocol_loop');
  if (input.candidate.continuation === 'runtime-thread') reasons.push('candidate_native_continuation');
  if (input.candidate.protocol !== input.attempt.protocol) reasons.push('protocol_mismatch');
  if (input.candidate.capabilityFingerprint !== input.attempt.capabilityFingerprint) {
    reasons.push('capability_fingerprint_mismatch');
  }
  if (input.candidate.toolSchemaFingerprint !== input.attempt.toolSchemaFingerprint) {
    reasons.push('tool_schema_fingerprint_mismatch');
  }
  if (!input.candidate.credentialsAvailable) reasons.push('credentials_unavailable');
  if (input.budget.nextAttempt > input.policy.limits.maxAttemptsPerStep) reasons.push('attempt_budget_exhausted');
  if (input.budget.elapsedMs >= input.policy.limits.maxWallClockMs) reasons.push('wall_clock_budget_exhausted');
  if (input.budget.usedTokens >= input.policy.limits.maxTokens) reasons.push('token_budget_exhausted');
  if (input.budget.estimatedCostUsd >= input.policy.limits.maxEstimatedCostUsd) {
    reasons.push('cost_budget_exhausted');
  }
  if (input.role !== 'auxiliary-read-only' && input.attempt.runtimeKind !== 'protocol-loop') {
    reasons.push('role_not_eligible');
  }
  return {
    allowed: reasons.length === 0,
    candidateId: input.candidate.id,
    policyVersion: input.policy.version,
    reasons,
  };
}
