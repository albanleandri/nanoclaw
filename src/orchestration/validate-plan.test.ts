import { describe, expect, it } from 'vitest';

import { compileDirectPlan } from './patterns/direct.js';
import { validateExecutionPlan } from './validate-plan.js';

function plan() {
  return compileDirectPlan({
    taskId: 'message:agent',
    objective: 'Please analyze this',
    kind: 'chat',
    agentGroupId: 'agent',
    sessionId: 'session',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

describe('ExecutionPlan validation', () => {
  it('compiles a bounded direct model-to-delivery graph', () => {
    expect(plan()).toMatchObject({
      schemaVersion: 1,
      pattern: { id: 'direct', version: 1 },
      steps: [
        { id: 'model', kind: 'model', dependsOn: [] },
        { id: 'delivery', kind: 'delivery', dependsOn: ['model'] },
      ],
      completion: { deliveryStepId: 'delivery' },
    });
  });

  it('rejects cycles, unknown capabilities, and extra direct steps', () => {
    const cyclic = plan();
    cyclic.steps[0].dependsOn = ['delivery'];
    expect(() => validateExecutionPlan(cyclic)).toThrow(/cycle/);

    const unknown = plan();
    unknown.roles[0].requiredCapabilities = ['unknown.capability'];
    expect(() => validateExecutionPlan(unknown)).toThrow(/Unknown role capability/);

    const extra = plan();
    extra.steps.push({ ...extra.steps[0], id: 'extra' });
    extra.budgets.maxSteps = 3;
    expect(() => validateExecutionPlan(extra)).toThrow(/cannot reach completion|direct@1/);
  });

  it('rejects steps that cannot contribute to the completion step', () => {
    const dangling = plan();
    dangling.pattern.id = 'review';
    dangling.steps.push({
      ...dangling.steps[0],
      id: 'dangling',
      kind: 'validation',
      dependsOn: [],
    });
    dangling.budgets.maxSteps = 3;
    expect(() => validateExecutionPlan(dangling)).toThrow(/cannot reach completion/);
  });
});
