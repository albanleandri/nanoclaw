import { describe, expect, it } from 'vitest';

import { assertAgentTaskTransition, validateAgentTaskEnvelope, validateAgentTaskEvent } from './agent-task-envelope.js';

const base = {
  taskId: 'task-123',
  requesterAgentGroupId: 'ag-requester',
  assigneeAgentGroupId: 'ag-assignee',
  goal: 'Review the implementation',
  requiredCapabilities: ['repo.edit'],
  scope: 'agent-delegation' as const,
};

describe('agent task envelope', () => {
  it('normalizes valid delegation and plan-role envelopes', () => {
    expect(
      validateAgentTaskEnvelope({ ...base, preferredRuntimeIds: ['codex-app-server', 'codex-app-server'] }),
    ).toMatchObject({ preferredRuntimeIds: ['codex-app-server'], artifactPolicy: 'summary-only' });
    expect(
      validateAgentTaskEnvelope({
        ...base,
        scope: 'plan-role',
        orchestrationRunId: 'run-1',
        orchestrationStepId: 'step-1',
        roleId: 'reviewer',
      }),
    ).toMatchObject({ scope: 'plan-role', roleId: 'reviewer' });
  });

  it('rejects malformed, unbounded, duplicate, and requester-mismatched input', () => {
    expect(() => validateAgentTaskEnvelope({ ...base, goal: '' })).toThrow(/goal/);
    expect(() => validateAgentTaskEnvelope({ ...base, context: 'x'.repeat(65_537) })).toThrow(/context/);
    expect(() => validateAgentTaskEnvelope({ ...base, requiredCapabilities: ['repo.edit', 'repo.edit'] })).toThrow(
      /duplicate/,
    );
    expect(() => validateAgentTaskEnvelope({ ...base, budget: { maxDurationMs: 0 } })).toThrow(/maxDurationMs/);
    expect(() => validateAgentTaskEnvelope({ ...base, artifactPolicy: 'anything' })).toThrow(/artifactPolicy/);
    expect(() => validateAgentTaskEnvelope({ ...base, unexpected: true })).toThrow(/unexpected/);
    expect(() => validateAgentTaskEnvelope(base, { requesterAgentGroupId: 'other' })).toThrow(/requester/);
    expect(() => validateAgentTaskEnvelope({ ...base, scope: 'plan-role' })).toThrow(/orchestrationRunId/);
  });
});

describe('agent task events and transitions', () => {
  it('validates typed event payloads', () => {
    expect(validateAgentTaskEvent({ type: 'progress', message: 'Halfway', current: 1, total: 2 })).toMatchObject({
      type: 'progress',
    });
    expect(validateAgentTaskEvent({ type: 'completed', result: { summary: 'done' } })).toMatchObject({
      type: 'completed',
    });
    expect(
      validateAgentTaskEvent({ type: 'artifact', filename: 'report.md', size: 12, sha256: 'a'.repeat(64) }),
    ).toMatchObject({ type: 'artifact' });
    expect(() => validateAgentTaskEvent({ type: 'progress', current: 3, total: 2 })).toThrow(/current/);
    expect(() => validateAgentTaskEvent({ type: 'failed', error: '' })).toThrow(/error/);
  });

  it('allows forward lifecycle transitions and rejects terminal escape', () => {
    expect(() => assertAgentTaskTransition('queued', 'running')).not.toThrow();
    expect(() => assertAgentTaskTransition('running', 'succeeded')).not.toThrow();
    expect(() => assertAgentTaskTransition('queued', 'cancelled')).not.toThrow();
    expect(() => assertAgentTaskTransition('succeeded', 'running')).toThrow(/transition/);
    expect(() => assertAgentTaskTransition('cancelled', 'succeeded')).toThrow(/transition/);
  });
});
