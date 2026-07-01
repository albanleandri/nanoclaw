import { createHash } from 'crypto';

import { writeSessionMessageIfAbsent } from '../session-manager.js';
import {
  ACTIVE_ADVANCED_FEATURE_POLICY,
  advancedFeatureEnabled,
  type AdvancedFeaturePolicy,
} from './advanced-feature-policy.js';
import './patterns/direct.js';
import { requirePattern } from './pattern-registry.js';
import { createOrchestrationRun, failRunDispatch, getStepAttempts, markRunDispatched } from './run-store.js';
import { validateExecutionPlan } from './validate-plan.js';

export function dispatchDirectExecution(input: {
  taskId: string;
  objective: string;
  agentGroupId: string;
  sessionId: string;
  message: Parameters<typeof writeSessionMessageIfAbsent>[2];
  advancedPolicy?: AdvancedFeaturePolicy;
}): { runId: string; inputMessageId: string } {
  const inputMessageId = input.message.id;
  const objective = input.objective.trim() || `Process inbound ${input.message.kind} message.`;
  const taskId = `task:${createHash('sha256')
    .update(`${input.agentGroupId}\0${input.sessionId}\0${input.taskId}`)
    .digest('hex')}`;
  const plan = requirePattern('direct', 1).compile({
    taskId,
    objective: objective.slice(0, 65_536),
    kind: input.message.kind,
    agentGroupId: input.agentGroupId,
    sessionId: input.sessionId,
    createdAt: input.message.timestamp,
  });
  const advancedPolicy = input.advancedPolicy ?? ACTIVE_ADVANCED_FEATURE_POLICY;
  if (advancedFeatureEnabled(advancedPolicy, 'fallback')) {
    const model = plan.steps.find((step) => step.kind === 'model')!;
    model.onFailure = 'fallback';
    model.retry.maxAttempts = advancedPolicy.limits.maxAttemptsPerStep;
    model.timeoutMs = Math.min(model.timeoutMs, advancedPolicy.limits.maxWallClockMs);
    plan.steps.find((step) => step.kind === 'delivery')!.timeoutMs = Math.min(
      plan.steps.find((step) => step.kind === 'delivery')!.timeoutMs,
      advancedPolicy.limits.maxWallClockMs,
    );
    plan.budgets.maxAttemptsPerStep = advancedPolicy.limits.maxAttemptsPerStep;
    plan.budgets.wallClockTimeoutMs = advancedPolicy.limits.maxWallClockMs;
    plan.metadata.policyVersion = advancedPolicy.version;
    validateExecutionPlan(plan);
  }
  const run = createOrchestrationRun(plan, inputMessageId);
  const modelAttempt = getStepAttempts(run.run_id).find((attempt) => attempt.kind === 'model')!;
  if (modelAttempt.status !== 'queued') return { runId: run.run_id, inputMessageId };
  try {
    writeSessionMessageIfAbsent(input.agentGroupId, input.sessionId, {
      ...input.message,
      orchestrationRunId: run.run_id,
    });
    markRunDispatched(run.run_id);
  } catch (error) {
    failRunDispatch(run.run_id, error);
    throw error;
  }
  return { runId: run.run_id, inputMessageId };
}
