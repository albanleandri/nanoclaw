import { describe, expect, it } from 'vitest';

import { DEFAULT_ADVANCED_FEATURE_POLICY } from './advanced-feature-policy.js';
import { evaluateFallback, stableFingerprint, type FallbackDecisionInput } from './fallback-policy.js';

function eligible(): FallbackDecisionInput {
  const policy = structuredClone(DEFAULT_ADVANCED_FEATURE_POLICY);
  policy.gates.fallback = {
    enabled: true,
    evaluationId: 'fallback-fixtures-2026-07-01',
    evaluatedPolicyVersion: policy.version,
  };
  policy.fallbackCandidates = ['backup-profile'];
  const capabilities = stableFingerprint([]);
  const tools = stableFingerprint([]);
  return {
    policy,
    taskClass: 'analysis',
    role: 'auxiliary-read-only',
    failure: { classification: 'transient', retryable: true },
    attempt: {
      runtimeKind: 'protocol-loop',
      protocol: 'openai-compatible',
      continuation: 'transcript',
      capabilityFingerprint: capabilities,
      toolSchemaFingerprint: tools,
      inputReconstructable: true,
      sideEffectBoundaryCrossed: false,
      resultEmitted: false,
      artifactEmitted: false,
      deliveryEmitted: false,
    },
    candidate: {
      id: 'backup-profile',
      runtimeKind: 'protocol-loop',
      protocol: 'openai-compatible',
      continuation: 'transcript',
      capabilityFingerprint: capabilities,
      toolSchemaFingerprint: tools,
      credentialsAvailable: true,
    },
    budget: { nextAttempt: 2, elapsedMs: 1_000, usedTokens: 100, estimatedCostUsd: 0.01 },
  };
}

describe('restricted fallback policy', () => {
  it('allows only evaluated, compatible, pre-side-effect protocol fallback', () => {
    expect(evaluateFallback(eligible())).toEqual({
      allowed: true,
      candidateId: 'backup-profile',
      policyVersion: 'advanced-features@1',
      reasons: [],
    });
  });

  it.each([
    ['post-tool', (input: FallbackDecisionInput) => (input.attempt.sideEffectBoundaryCrossed = true), 'side_effect'],
    [
      'unknown-state',
      (input: FallbackDecisionInput) => (input.attempt.sideEffectBoundaryCrossed = null),
      'side_effect',
    ],
    ['auth', (input: FallbackDecisionInput) => (input.failure.classification = 'auth'), 'failure'],
    ['quota', (input: FallbackDecisionInput) => (input.failure.classification = 'quota'), 'failure'],
    [
      'capabilities',
      (input: FallbackDecisionInput) => (input.candidate.capabilityFingerprint = 'different'),
      'capability',
    ],
    ['tools', (input: FallbackDecisionInput) => (input.candidate.toolSchemaFingerprint = 'different'), 'tool_schema'],
    ['budget', (input: FallbackDecisionInput) => (input.budget.nextAttempt = 3), 'attempt_budget'],
  ])('rejects %s fallback', (_name, mutate, reason) => {
    const input = eligible();
    mutate(input);
    expect(evaluateFallback(input)).toMatchObject({ allowed: false });
    expect(evaluateFallback(input).reasons.some((item) => item.includes(reason))).toBe(true);
  });

  it('rejects native continuation migration even with otherwise equal facts', () => {
    const input = eligible();
    input.attempt.runtimeKind = 'native-harness';
    input.attempt.continuation = 'runtime-thread';
    expect(evaluateFallback(input).reasons).toEqual(
      expect.arrayContaining(['native_harness_migration_denied', 'native_continuation_denied']),
    );
  });
});
