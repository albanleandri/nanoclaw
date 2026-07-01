import '../capabilities/builtins/index.js';
import { getCapability } from '../capabilities/capability-registry.js';
import type { ExecutionPlan } from './types.js';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;

function positiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

export function validateExecutionPlan(plan: ExecutionPlan): ExecutionPlan {
  if (plan.schemaVersion !== 1) throw new Error('Unsupported ExecutionPlan schemaVersion');
  for (const [label, value] of [
    ['planId', plan.planId],
    ['taskId', plan.taskId],
    ['agentGroupId', plan.metadata.agentGroupId],
    ['sessionId', plan.metadata.sessionId],
  ]) {
    if (!ID.test(value)) throw new Error(`Invalid ExecutionPlan ${label}`);
  }
  if (!plan.objective.trim() || plan.objective.length > 65_536) throw new Error('Invalid ExecutionPlan objective');
  if (
    plan.assessment.version !== 1 ||
    ![
      'conversation',
      'lookup',
      'content_generation',
      'analysis',
      'software_change',
      'operations',
      'scheduled_work',
      'deterministic_job',
      'unknown',
    ].includes(plan.assessment.taskClass) ||
    !['interactive', 'normal', 'background'].includes(plan.assessment.urgency) ||
    !['trivial', 'bounded', 'complex', 'open_ended'].includes(plan.assessment.complexity) ||
    !['reversible', 'partially_reversible', 'irreversible'].includes(plan.assessment.reversibility) ||
    !['low', 'medium', 'high', 'critical'].includes(plan.assessment.trustRisk) ||
    !['none', 'light', 'independent', 'human'].includes(plan.assessment.verificationNeed)
  ) {
    throw new Error('Invalid ExecutionPlan assessment');
  }
  if (plan.pattern.version !== 1 || !['direct', 'review'].includes(plan.pattern.id)) {
    throw new Error('Unsupported ExecutionPlan pattern');
  }
  positiveInteger(plan.budgets.maxSteps, 'maxSteps');
  positiveInteger(plan.budgets.maxAttemptsPerStep, 'maxAttemptsPerStep');
  positiveInteger(plan.budgets.maxParallelism, 'maxParallelism');
  positiveInteger(plan.budgets.wallClockTimeoutMs, 'wallClockTimeoutMs');
  if (!Number.isFinite(Date.parse(plan.metadata.createdAt))) throw new Error('Invalid ExecutionPlan createdAt');
  if (plan.budgets.maxParallelism > plan.budgets.maxSteps) {
    throw new Error('ExecutionPlan parallelism exceeds step budget');
  }
  if (plan.steps.length < 1 || plan.steps.length > plan.budgets.maxSteps)
    throw new Error('ExecutionPlan step budget exceeded');

  const roleIds = new Set<string>();
  for (const role of plan.roles) {
    if (!ID.test(role.id) || roleIds.has(role.id)) throw new Error(`Invalid or duplicate role: ${role.id}`);
    roleIds.add(role.id);
    if (
      !['executor', 'planner', 'worker', 'reviewer', 'synthesizer'].includes(role.kind) ||
      !['read_write', 'read_only', 'artifact_only'].includes(role.workspaceAccess) ||
      !['conversation', 'agent', 'task', 'none'].includes(role.memoryScope) ||
      role.routing.strategy !== 'inherit-session'
    ) {
      throw new Error(`Invalid role contract: ${role.id}`);
    }
    for (const capability of role.requiredCapabilities) {
      if (!getCapability(capability)) throw new Error(`Unknown role capability: ${capability}`);
    }
  }

  const stepIds = new Set<string>();
  for (const step of plan.steps) {
    if (!ID.test(step.id) || stepIds.has(step.id)) throw new Error(`Invalid or duplicate step: ${step.id}`);
    stepIds.add(step.id);
    if (step.roleId && !roleIds.has(step.roleId)) throw new Error(`Unknown role for step ${step.id}`);
    if (
      !['model', 'tool', 'job', 'approval', 'validation', 'merge', 'delivery'].includes(step.kind) ||
      !['fail_plan', 'skip', 'retry', 'escalate', 'fallback'].includes(step.onFailure)
    ) {
      throw new Error(`Invalid step contract: ${step.id}`);
    }
    positiveInteger(step.retry.maxAttempts, `retry.maxAttempts for ${step.id}`);
    positiveInteger(step.timeoutMs, `timeoutMs for ${step.id}`);
    if (step.timeoutMs > plan.budgets.wallClockTimeoutMs) {
      throw new Error(`Step timeout exceeds plan wall-clock budget: ${step.id}`);
    }
    if (step.retry.maxAttempts > plan.budgets.maxAttemptsPerStep)
      throw new Error(`Attempt budget exceeded: ${step.id}`);
    for (const capability of step.requiredCapabilities) {
      if (!getCapability(capability)) throw new Error(`Unknown step capability: ${capability}`);
    }
  }
  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency) || dependency === step.id) throw new Error(`Invalid dependency for step ${step.id}`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('ExecutionPlan dependency cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of stepIds) visit(id);

  const deliverySteps = plan.steps.filter((step) => step.kind === 'delivery');
  if (deliverySteps.length !== 1 || deliverySteps[0].id !== plan.completion.deliveryStepId) {
    throw new Error('ExecutionPlan must have exactly one completion delivery step');
  }
  const reachesCompletion = new Set<string>();
  const markCompletionAncestor = (id: string): void => {
    if (reachesCompletion.has(id)) return;
    reachesCompletion.add(id);
    for (const dependency of byId.get(id)!.dependsOn) markCompletionAncestor(dependency);
  };
  markCompletionAncestor(plan.completion.deliveryStepId);
  if (reachesCompletion.size !== plan.steps.length) {
    throw new Error('ExecutionPlan contains a step that cannot reach completion');
  }
  if (plan.pattern.id === 'direct') {
    const model = plan.steps.find((step) => step.kind === 'model');
    const delivery = deliverySteps[0];
    if (
      plan.roles.length !== 1 ||
      plan.roles[0].kind !== 'executor' ||
      plan.steps.length !== 2 ||
      !model ||
      delivery.dependsOn.length !== 1 ||
      delivery.dependsOn[0] !== model.id
    ) {
      throw new Error('direct@1 must be one executor model step followed by delivery');
    }
  }
  return plan;
}
