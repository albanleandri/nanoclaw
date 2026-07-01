import type { FallbackDecisionInput } from '../fallback-policy.js';

export interface FallbackEvalFixture {
  name: string;
  mutate(input: FallbackDecisionInput): void;
  expectedAllowed: boolean;
}

export const FALLBACK_EVAL_FIXTURES: FallbackEvalFixture[] = [
  { name: 'transient-pre-tool', mutate: () => undefined, expectedAllowed: true },
  {
    name: 'post-tool-failure',
    mutate: (input) => {
      input.attempt.sideEffectBoundaryCrossed = true;
    },
    expectedAllowed: false,
  },
  {
    name: 'cancelled',
    mutate: (input) => {
      input.failure = { classification: 'unknown', retryable: false };
    },
    expectedAllowed: false,
  },
  {
    name: 'crash-unknown-boundary',
    mutate: (input) => {
      input.attempt.sideEffectBoundaryCrossed = null;
    },
    expectedAllowed: false,
  },
  {
    name: 'conflicting-capability-contract',
    mutate: (input) => {
      input.candidate.capabilityFingerprint = 'conflict';
    },
    expectedAllowed: false,
  },
  {
    name: 'exhausted-budget',
    mutate: (input) => {
      input.budget.usedTokens = input.policy.limits.maxTokens;
    },
    expectedAllowed: false,
  },
];
