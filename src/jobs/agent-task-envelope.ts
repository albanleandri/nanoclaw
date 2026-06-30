import type { JobStatus } from '../db/jobs.js';

export type AgentTaskArtifactPolicy = 'summary-only' | 'files' | 'full-trace';

export interface AgentTaskBudget {
  maxIterations?: number;
  maxDurationMs?: number;
  maxCostUsd?: number;
}

export interface AgentTaskEnvelopeBase {
  taskId: string;
  parentTaskId?: string;
  requesterAgentGroupId: string;
  assigneeAgentGroupId: string;
  goal: string;
  context?: string;
  requiredCapabilities: string[];
  preferredRuntimeIds?: string[];
  budget?: AgentTaskBudget;
  artifactPolicy: AgentTaskArtifactPolicy;
}

export type AgentTaskEnvelope = AgentTaskEnvelopeBase &
  (
    | { scope: 'agent-delegation' }
    | {
        scope: 'plan-role';
        orchestrationRunId: string;
        orchestrationStepId: string;
        roleId: string;
      }
  );

export type AgentTaskEvent =
  | { type: 'accepted' | 'started' | 'cancelled'; message?: string }
  | { type: 'progress'; message: string; current?: number; total?: number }
  | { type: 'blocked'; reason: string }
  | { type: 'artifact'; filename: string; size: number; sha256: string; mediaType?: string; localPath?: string }
  | { type: 'completed'; result: unknown }
  | { type: 'failed'; error: string };

const BASE_FIELDS = new Set([
  'taskId',
  'parentTaskId',
  'requesterAgentGroupId',
  'assigneeAgentGroupId',
  'goal',
  'context',
  'requiredCapabilities',
  'preferredRuntimeIds',
  'budget',
  'artifactPolicy',
  'scope',
]);
const PLAN_FIELDS = new Set(['orchestrationRunId', 'orchestrationStepId', 'roleId']);
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const CAPABILITY_RE = /^[a-z0-9][a-z0-9.-]{1,127}$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  if (value.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return value.trim();
}

function identifier(value: unknown, label: string): string {
  const result = boundedString(value, label, 128);
  if (!ID_RE.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function stringList(value: unknown, label: string, pattern: RegExp, rejectDuplicates: boolean): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = value.map((item, index) => {
    const text = boundedString(item, `${label}[${index}]`, 128);
    if (!pattern.test(text)) throw new Error(`${label}[${index}] is invalid`);
    return text;
  });
  if (rejectDuplicates && new Set(result).size !== result.length) throw new Error(`${label} contains a duplicate`);
  return [...new Set(result)];
}

function positiveNumber(value: unknown, label: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} must be a positive ${integer ? 'integer' : 'number'}`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
}

export function validateAgentTaskEnvelope(
  value: unknown,
  expected?: { requesterAgentGroupId?: string },
): AgentTaskEnvelope {
  const input = record(value, 'envelope');
  const scope = input.scope;
  if (scope !== 'agent-delegation' && scope !== 'plan-role') throw new Error('scope is invalid');
  const allowed = scope === 'plan-role' ? new Set([...BASE_FIELDS, ...PLAN_FIELDS]) : BASE_FIELDS;
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`unexpected envelope field: ${key}`);

  const requesterAgentGroupId = identifier(input.requesterAgentGroupId, 'requesterAgentGroupId');
  if (expected?.requesterAgentGroupId && requesterAgentGroupId !== expected.requesterAgentGroupId) {
    throw new Error('requesterAgentGroupId does not match the acting requester');
  }
  const requiredCapabilities = stringList(input.requiredCapabilities, 'requiredCapabilities', CAPABILITY_RE, true);
  const preferredRuntimeIds =
    input.preferredRuntimeIds === undefined
      ? undefined
      : stringList(input.preferredRuntimeIds, 'preferredRuntimeIds', ID_RE, false);
  let budget: AgentTaskBudget | undefined;
  if (input.budget !== undefined) {
    const raw = record(input.budget, 'budget');
    for (const key of Object.keys(raw)) {
      if (!['maxIterations', 'maxDurationMs', 'maxCostUsd'].includes(key))
        throw new Error(`unexpected budget field: ${key}`);
    }
    budget = {
      ...(raw.maxIterations === undefined
        ? {}
        : { maxIterations: positiveNumber(raw.maxIterations, 'maxIterations', true) }),
      ...(raw.maxDurationMs === undefined ? {} : { maxDurationMs: positiveNumber(raw.maxDurationMs, 'maxDurationMs') }),
      ...(raw.maxCostUsd === undefined ? {} : { maxCostUsd: positiveNumber(raw.maxCostUsd, 'maxCostUsd') }),
    };
  }
  const artifactPolicy = input.artifactPolicy ?? 'summary-only';
  if (!['summary-only', 'files', 'full-trace'].includes(String(artifactPolicy))) {
    throw new Error('artifactPolicy is invalid');
  }
  const common: AgentTaskEnvelopeBase = {
    taskId: identifier(input.taskId, 'taskId'),
    ...(input.parentTaskId === undefined ? {} : { parentTaskId: identifier(input.parentTaskId, 'parentTaskId') }),
    requesterAgentGroupId,
    assigneeAgentGroupId: identifier(input.assigneeAgentGroupId, 'assigneeAgentGroupId'),
    goal: boundedString(input.goal, 'goal', 16_384),
    ...(input.context === undefined ? {} : { context: boundedString(input.context, 'context', 65_536) }),
    requiredCapabilities,
    ...(preferredRuntimeIds ? { preferredRuntimeIds } : {}),
    ...(budget ? { budget } : {}),
    artifactPolicy: artifactPolicy as AgentTaskArtifactPolicy,
  };
  if (scope === 'agent-delegation') return { ...common, scope };
  return {
    ...common,
    scope,
    orchestrationRunId: identifier(input.orchestrationRunId, 'orchestrationRunId'),
    orchestrationStepId: identifier(input.orchestrationStepId, 'orchestrationStepId'),
    roleId: identifier(input.roleId, 'roleId'),
  };
}

export function validateAgentTaskEvent(value: unknown): AgentTaskEvent {
  const input = record(value, 'event');
  switch (input.type) {
    case 'accepted':
    case 'started':
    case 'cancelled':
      return {
        type: input.type,
        ...(input.message === undefined ? {} : { message: boundedString(input.message, 'message', 4096) }),
      };
    case 'progress': {
      const current = input.current === undefined ? undefined : positiveNumber(input.current, 'current');
      const total = input.total === undefined ? undefined : positiveNumber(input.total, 'total');
      if (current !== undefined && total !== undefined && current > total) throw new Error('current exceeds total');
      return {
        type: 'progress',
        message: boundedString(input.message, 'message', 16_384),
        ...(current === undefined ? {} : { current }),
        ...(total === undefined ? {} : { total }),
      };
    }
    case 'blocked':
      return { type: 'blocked', reason: boundedString(input.reason, 'reason', 16_384) };
    case 'artifact':
      if (typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)) {
        throw new Error('sha256 must be a lowercase hex digest');
      }
      return {
        type: 'artifact',
        filename: boundedString(input.filename, 'filename', 255),
        size: nonNegativeNumber(input.size, 'size'),
        sha256: input.sha256,
        ...(input.mediaType === undefined ? {} : { mediaType: boundedString(input.mediaType, 'mediaType', 255) }),
        ...(input.localPath === undefined ? {} : { localPath: boundedString(input.localPath, 'localPath', 1024) }),
      };
    case 'completed':
      return { type: 'completed', result: input.result };
    case 'failed':
      return { type: 'failed', error: boundedString(input.error, 'error', 16_384) };
    default:
      throw new Error('event type is invalid');
  }
}

const ALLOWED_TRANSITIONS: Record<JobStatus, ReadonlySet<JobStatus>> = {
  queued: new Set(['running', 'failed', 'cancelled']),
  running: new Set(['succeeded', 'failed', 'cancelled']),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function assertAgentTaskTransition(from: JobStatus, to: JobStatus): void {
  if (from === to) return;
  if (!ALLOWED_TRANSITIONS[from].has(to)) throw new Error(`Invalid agent task transition: ${from} → ${to}`);
}
