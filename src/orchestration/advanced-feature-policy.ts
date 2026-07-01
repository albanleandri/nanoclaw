import type { TaskAssessment } from './types.js';

export type AdvancedFeature = 'fallback' | 'planRoleWorkers' | 'ensembles' | 'graphRecovery';

export interface AdvancedFeatureGate {
  enabled: boolean;
  evaluationId?: string;
  evaluatedPolicyVersion?: string;
}

export interface AdvancedFeaturePolicy {
  version: string;
  gates: Record<AdvancedFeature, AdvancedFeatureGate>;
  fallbackCandidates: string[];
  limits: {
    maxConcurrency: number;
    maxDepth: number;
    maxAttemptsPerStep: number;
    maxWallClockMs: number;
    maxTokens: number;
    maxEstimatedCostUsd: number;
  };
  allowedTaskClasses: TaskAssessment['taskClass'][];
}

export const DEFAULT_ADVANCED_FEATURE_POLICY: AdvancedFeaturePolicy = {
  version: 'advanced-features@1',
  gates: {
    fallback: { enabled: false },
    planRoleWorkers: { enabled: false },
    ensembles: { enabled: false },
    graphRecovery: { enabled: false },
  },
  fallbackCandidates: [],
  limits: {
    maxConcurrency: 1,
    maxDepth: 1,
    maxAttemptsPerStep: 2,
    maxWallClockMs: 10 * 60_000,
    maxTokens: 32_000,
    maxEstimatedCostUsd: 1,
  },
  allowedTaskClasses: ['lookup', 'content_generation', 'analysis'],
};

const TASK_CLASSES = new Set<TaskAssessment['taskClass']>([
  'conversation',
  'lookup',
  'content_generation',
  'analysis',
  'software_change',
  'operations',
  'scheduled_work',
  'deterministic_job',
  'unknown',
]);

function positiveFinite(value: number, label: string, integer = false): void {
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`Advanced feature policy ${label} must be a positive ${integer ? 'integer' : 'number'}`);
  }
}

export function validateAdvancedFeaturePolicy(policy: AdvancedFeaturePolicy): AdvancedFeaturePolicy {
  if (!/^[a-z0-9][a-z0-9-]*@\d+$/.test(policy.version)) {
    throw new Error('Advanced feature policy version must be a stable name@number');
  }
  for (const feature of ['fallback', 'planRoleWorkers', 'ensembles', 'graphRecovery'] as const) {
    const gate = policy.gates[feature];
    if (!gate || typeof gate.enabled !== 'boolean') throw new Error(`Missing advanced feature gate: ${feature}`);
    if (gate.enabled && (!gate.evaluationId?.trim() || gate.evaluatedPolicyVersion !== policy.version)) {
      throw new Error(`Enabled advanced feature ${feature} requires an evaluation for ${policy.version}`);
    }
  }
  if (
    new Set(policy.fallbackCandidates).size !== policy.fallbackCandidates.length ||
    policy.fallbackCandidates.some((id) => !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(id))
  ) {
    throw new Error('Advanced feature policy has invalid fallback candidates');
  }
  if (policy.gates.fallback.enabled && policy.fallbackCandidates.length === 0) {
    throw new Error('Enabled fallback requires at least one explicit candidate profile');
  }
  positiveFinite(policy.limits.maxConcurrency, 'maxConcurrency', true);
  positiveFinite(policy.limits.maxDepth, 'maxDepth', true);
  positiveFinite(policy.limits.maxAttemptsPerStep, 'maxAttemptsPerStep', true);
  positiveFinite(policy.limits.maxWallClockMs, 'maxWallClockMs', true);
  positiveFinite(policy.limits.maxTokens, 'maxTokens', true);
  positiveFinite(policy.limits.maxEstimatedCostUsd, 'maxEstimatedCostUsd');
  if (
    policy.allowedTaskClasses.length === 0 ||
    new Set(policy.allowedTaskClasses).size !== policy.allowedTaskClasses.length ||
    policy.allowedTaskClasses.some((taskClass) => !TASK_CLASSES.has(taskClass))
  ) {
    throw new Error('Advanced feature policy has invalid allowed task classes');
  }
  return policy;
}

/** Code-owned rollout policy. Enabling it is an explicit reviewed change. */
export const ACTIVE_ADVANCED_FEATURE_POLICY: AdvancedFeaturePolicy = DEFAULT_ADVANCED_FEATURE_POLICY;

export function advancedFeatureEnabled(policy: AdvancedFeaturePolicy, feature: AdvancedFeature): boolean {
  validateAdvancedFeaturePolicy(policy);
  return policy.gates[feature].enabled;
}
