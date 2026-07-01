import { describe, expect, it } from 'vitest';

import { DEFAULT_ADVANCED_FEATURE_POLICY } from '../advanced-feature-policy.js';
import { evaluateFallback, stableFingerprint, type FallbackDecisionInput } from '../fallback-policy.js';
import { FALLBACK_EVAL_FIXTURES } from './fallback-fixtures.js';

function baseline(): FallbackDecisionInput {
  const policy = structuredClone(DEFAULT_ADVANCED_FEATURE_POLICY);
  policy.gates.fallback = {
    enabled: true,
    evaluationId: 'fallback-fixtures-2026-07-01',
    evaluatedPolicyVersion: policy.version,
  };
  policy.fallbackCandidates = ['evaluated-backup'];
  const fingerprint = stableFingerprint([]);
  return {
    policy,
    taskClass: 'analysis',
    role: 'auxiliary-read-only',
    failure: { classification: 'transient', retryable: true },
    attempt: {
      runtimeKind: 'protocol-loop',
      protocol: 'openai-compatible',
      continuation: 'transcript',
      capabilityFingerprint: fingerprint,
      toolSchemaFingerprint: fingerprint,
      inputReconstructable: true,
      sideEffectBoundaryCrossed: false,
      resultEmitted: false,
      artifactEmitted: false,
      deliveryEmitted: false,
    },
    candidate: {
      id: 'evaluated-backup',
      runtimeKind: 'protocol-loop',
      protocol: 'openai-compatible',
      continuation: 'transcript',
      capabilityFingerprint: fingerprint,
      toolSchemaFingerprint: fingerprint,
      credentialsAvailable: true,
    },
    budget: { nextAttempt: 2, elapsedMs: 500, usedTokens: 100, estimatedCostUsd: 0.01 },
  };
}

describe('fallback acceptance fixtures', () => {
  it.each(FALLBACK_EVAL_FIXTURES)('$name', (fixture) => {
    const input = baseline();
    fixture.mutate(input);
    expect(evaluateFallback(input).allowed).toBe(fixture.expectedAllowed);
  });
});
