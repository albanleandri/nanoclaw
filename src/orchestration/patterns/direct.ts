import { assessDirectTask } from '../assessment.js';
import { registerPattern } from '../pattern-registry.js';
import type { ExecutionPlan } from '../types.js';
import { validateExecutionPlan } from '../validate-plan.js';

export function compileDirectPlan(input: {
  taskId: string;
  objective: string;
  kind: string;
  agentGroupId: string;
  sessionId: string;
  createdAt?: string;
}): ExecutionPlan {
  const plan: ExecutionPlan = {
    schemaVersion: 1,
    planId: `plan:${input.taskId}`,
    taskId: input.taskId,
    pattern: { id: 'direct', version: 1 },
    objective: input.objective,
    assessment: assessDirectTask({ kind: input.kind, text: input.objective }),
    roles: [
      {
        id: 'executor',
        kind: 'executor',
        instructions: 'Execute the user request through the existing session runtime.',
        workspaceAccess: 'read_write',
        memoryScope: 'conversation',
        requiredCapabilities: [],
        routing: { strategy: 'inherit-session' },
      },
    ],
    steps: [
      {
        id: 'model',
        roleId: 'executor',
        kind: 'model',
        dependsOn: [],
        requiredCapabilities: [],
        retry: { maxAttempts: 1 },
        timeoutMs: 30 * 60_000,
        onFailure: 'fail_plan',
      },
      {
        id: 'delivery',
        kind: 'delivery',
        dependsOn: ['model'],
        requiredCapabilities: [],
        retry: { maxAttempts: 1 },
        timeoutMs: 5 * 60_000,
        onFailure: 'fail_plan',
      },
    ],
    budgets: {
      maxSteps: 2,
      maxAttemptsPerStep: 1,
      maxParallelism: 1,
      wallClockTimeoutMs: 35 * 60_000,
    },
    completion: { deliveryStepId: 'delivery' },
    failure: { onStepFailure: 'fail_plan' },
    metadata: {
      agentGroupId: input.agentGroupId,
      sessionId: input.sessionId,
      createdAt: input.createdAt ?? new Date().toISOString(),
      policyVersion: 'direct@1',
      shadow: false,
    },
  };
  return validateExecutionPlan(plan);
}

registerPattern({
  id: 'direct',
  version: 1,
  description: 'One existing session-runtime model turn followed by one user-facing delivery.',
  compile: compileDirectPlan,
});
