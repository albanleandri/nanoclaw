import { describe, expect, it } from 'vitest';

import {
  advancedFeatureEnabled,
  DEFAULT_ADVANCED_FEATURE_POLICY,
  validateAdvancedFeaturePolicy,
} from './advanced-feature-policy.js';

describe('advanced feature policy', () => {
  it('keeps every advanced feature independently disabled by default', () => {
    for (const feature of ['fallback', 'planRoleWorkers', 'ensembles', 'graphRecovery'] as const) {
      expect(advancedFeatureEnabled(DEFAULT_ADVANCED_FEATURE_POLICY, feature)).toBe(false);
    }
  });

  it('requires an explicit same-version evaluation before activation', () => {
    const policy = structuredClone(DEFAULT_ADVANCED_FEATURE_POLICY);
    policy.gates.fallback = { enabled: true, evaluationId: 'fallback-fixtures-2026-07-01' };
    expect(() => validateAdvancedFeaturePolicy(policy)).toThrow(/evaluation/);
    policy.gates.fallback.evaluatedPolicyVersion = policy.version;
    policy.fallbackCandidates = ['backup-profile'];
    expect(advancedFeatureEnabled(policy, 'fallback')).toBe(true);
  });

  it('rejects unbounded or malformed limits and task classes', () => {
    const policy = structuredClone(DEFAULT_ADVANCED_FEATURE_POLICY);
    policy.limits.maxConcurrency = 0;
    expect(() => validateAdvancedFeaturePolicy(policy)).toThrow(/maxConcurrency/);
    policy.limits.maxConcurrency = 1;
    policy.allowedTaskClasses = ['analysis', 'analysis'];
    expect(() => validateAdvancedFeaturePolicy(policy)).toThrow(/task classes/);
  });
});
