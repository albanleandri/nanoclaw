import { DEFAULT_ADVANCED_FEATURE_POLICY } from '../advanced-feature-policy.js';
import { listOrchestrationRuns } from '../run-store.js';
import type { ModelUsage } from '../../auxiliary/types.js';
import { ADVANCED_ACCEPTANCE_FIXTURES } from './acceptance-fixtures.js';
import { FALLBACK_EVAL_FIXTURES } from './fallback-fixtures.js';

export const FALLBACK_ROLLOUT_THRESHOLDS = {
  duplicateSideEffects: 0,
  minimumEligibleFailureRecoveryRate: 0.5,
  maximumLatencyMultiplier: 2,
  maximumUsageMultiplier: 2,
} as const;

function totalUsage(items: Array<ModelUsage | undefined>): Omit<ModelUsage, 'source'> {
  return items.reduce<Omit<ModelUsage, 'source'>>(
    (total, usage) => ({
      inputTokens: (total.inputTokens ?? 0) + (usage?.inputTokens ?? 0),
      outputTokens: (total.outputTokens ?? 0) + (usage?.outputTokens ?? 0),
      cachedTokens: (total.cachedTokens ?? 0) + (usage?.cachedTokens ?? 0),
      estimatedCostUsd: (total.estimatedCostUsd ?? 0) + (usage?.estimatedCostUsd ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cachedTokens: 0, estimatedCostUsd: 0 },
  );
}

export function advancedFeatureEvalReport(
  agentGroupId: string,
  limit = 200,
): {
  policy: typeof DEFAULT_ADVANCED_FEATURE_POLICY;
  directBaseline: {
    sampleSize: number;
    terminalRuns: number;
    succeededRuns: number;
    successRate: number | null;
    averageTerminalLatencyMs: number | null;
    usage: Omit<ModelUsage, 'source'>;
  };
  fallbackFixtures: Array<{ name: string; expectedAllowed: boolean }>;
  acceptanceFixtures: typeof ADVANCED_ACCEPTANCE_FIXTURES;
  fallbackGate: {
    status: 'requires-controlled-evaluation';
    thresholds: typeof FALLBACK_ROLLOUT_THRESHOLDS;
    note: string;
  };
  activation: { automatic: false; note: string };
} {
  const boundedLimit = Number.isFinite(limit) ? limit : 200;
  const runs = listOrchestrationRuns({ agentGroupId, limit: boundedLimit }).filter(
    (run) => run.pattern_id === 'direct' && run.pattern_version === 1,
  );
  const terminal = runs.filter((run) => run.finished_at);
  const succeeded = terminal.filter((run) => run.status === 'succeeded');
  const latencies = terminal
    .map((run) => Date.parse(run.finished_at!) - Date.parse(run.created_at))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return {
    policy: structuredClone(DEFAULT_ADVANCED_FEATURE_POLICY),
    directBaseline: {
      sampleSize: runs.length,
      terminalRuns: terminal.length,
      succeededRuns: succeeded.length,
      successRate: terminal.length === 0 ? null : succeeded.length / terminal.length,
      averageTerminalLatencyMs:
        latencies.length === 0 ? null : latencies.reduce((total, value) => total + value, 0) / latencies.length,
      usage: totalUsage(runs.map((run) => run.usage)),
    },
    fallbackFixtures: FALLBACK_EVAL_FIXTURES.map(({ name, expectedAllowed }) => ({ name, expectedAllowed })),
    acceptanceFixtures: ADVANCED_ACCEPTANCE_FIXTURES,
    fallbackGate: {
      status: 'requires-controlled-evaluation',
      thresholds: FALLBACK_ROLLOUT_THRESHOLDS,
      note: 'Compare an explicitly named candidate against a matching failed direct cohort before changing the code-owned active policy.',
    },
    activation: {
      automatic: false,
      note: 'Review this report, run the named fixtures, then activate only an explicitly evaluated policy version.',
    },
  };
}
