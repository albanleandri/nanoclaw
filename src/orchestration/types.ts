import type { ModelUsage } from '../auxiliary/types.js';

export type PatternId = 'direct' | 'review';
export type OrchestrationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type StepStatus = OrchestrationStatus | 'needs_input';

export interface TaskAssessment {
  version: 1;
  taskClass:
    | 'conversation'
    | 'lookup'
    | 'content_generation'
    | 'analysis'
    | 'software_change'
    | 'operations'
    | 'scheduled_work'
    | 'deterministic_job'
    | 'unknown';
  urgency: 'interactive' | 'normal' | 'background';
  complexity: 'trivial' | 'bounded' | 'complex' | 'open_ended';
  reversibility: 'reversible' | 'partially_reversible' | 'irreversible';
  trustRisk: 'low' | 'medium' | 'high' | 'critical';
  verificationNeed: 'none' | 'light' | 'independent' | 'human';
}

export interface ExecutionRole {
  id: string;
  kind: 'executor' | 'planner' | 'worker' | 'reviewer' | 'synthesizer';
  instructions: string;
  workspaceAccess: 'read_write' | 'read_only' | 'artifact_only';
  memoryScope: 'conversation' | 'agent' | 'task' | 'none';
  requiredCapabilities: string[];
  routing: { strategy: 'inherit-session' };
}

export interface ExecutionStep {
  id: string;
  roleId?: string;
  kind: 'model' | 'tool' | 'job' | 'approval' | 'validation' | 'merge' | 'delivery';
  dependsOn: string[];
  requiredCapabilities: string[];
  retry: { maxAttempts: number };
  timeoutMs: number;
  onFailure: 'fail_plan' | 'skip' | 'retry' | 'escalate' | 'fallback';
}

export interface ExecutionPlan {
  schemaVersion: 1;
  planId: string;
  taskId: string;
  pattern: { id: PatternId; version: number };
  objective: string;
  assessment: TaskAssessment;
  roles: ExecutionRole[];
  steps: ExecutionStep[];
  budgets: {
    maxSteps: number;
    maxAttemptsPerStep: number;
    maxParallelism: number;
    wallClockTimeoutMs: number;
  };
  completion: { deliveryStepId: string };
  failure: { onStepFailure: 'fail_plan' };
  metadata: {
    agentGroupId: string;
    sessionId: string;
    createdAt: string;
    policyVersion: string;
    shadow: boolean;
  };
}

export interface StepResult {
  stepId: string;
  attempt: number;
  status: 'succeeded' | 'failed' | 'cancelled' | 'needs_input';
  usage?: ModelUsage;
  timing: { queuedAt: string; startedAt?: string; finishedAt: string };
  error?: { classification: string; retryable: boolean; message: string };
}
