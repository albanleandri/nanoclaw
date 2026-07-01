import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { writeSessionMessageIfAbsent } = vi.hoisted(() => ({
  writeSessionMessageIfAbsent: vi.fn(() => true),
}));
vi.mock('../session-manager.js', () => ({ writeSessionMessageIfAbsent }));

import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from '../db/index.js';
import { DEFAULT_ADVANCED_FEATURE_POLICY } from './advanced-feature-policy.js';
import { dispatchDirectExecution } from './engine.js';
import { getOrchestrationRun, getStepAttempts } from './run-store.js';

beforeEach(() => {
  writeSessionMessageIfAbsent.mockClear();
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'agent', name: 'Agent', folder: 'agent', agent_provider: null, created_at: '2026-01-01' });
  createSession({
    id: 'session',
    agent_group_id: 'agent',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-01-01',
  });
});
afterEach(closeDb);

describe('direct orchestration executor', () => {
  it('persists before dispatch and is idempotent for one inbound message', () => {
    const input = {
      taskId: 'external/id with spaces',
      objective: 'hello',
      agentGroupId: 'agent',
      sessionId: 'session',
      message: {
        id: 'external/id with spaces:agent',
        kind: 'chat',
        timestamp: '2026-01-01T00:00:00.000Z',
        content: JSON.stringify({ text: 'hello' }),
      },
    };
    const first = dispatchDirectExecution(input);
    const second = dispatchDirectExecution(input);
    expect(second).toEqual(first);
    expect(writeSessionMessageIfAbsent).toHaveBeenCalledTimes(1);
    expect(writeSessionMessageIfAbsent).toHaveBeenCalledWith(
      'agent',
      'session',
      expect.objectContaining({
        id: 'external/id with spaces:agent',
        orchestrationRunId: expect.any(String),
      }),
    );
    expect(getOrchestrationRun(first.runId)?.status).toBe('running');
    expect(getStepAttempts(first.runId).map((attempt) => attempt.status)).toEqual(['running', 'queued']);
  });

  it('rejects a stable task identity reused with different content', () => {
    const input = {
      taskId: 'message',
      objective: 'first',
      agentGroupId: 'agent',
      sessionId: 'session',
      message: {
        id: 'message:agent',
        kind: 'chat',
        timestamp: '2026-01-01T00:00:00.000Z',
        content: JSON.stringify({ text: 'first' }),
      },
    };
    dispatchDirectExecution(input);
    expect(() => dispatchDirectExecution({ ...input, objective: 'different' })).toThrow(/identity conflict/);
  });

  it('uses a bounded fallback objective for attachment-only inbound', () => {
    const result = dispatchDirectExecution({
      taskId: 'attachment',
      objective: '',
      agentGroupId: 'agent',
      sessionId: 'session',
      message: {
        id: 'attachment:agent',
        kind: 'chat',
        timestamp: '2026-01-01T00:00:00.000Z',
        content: JSON.stringify({ attachments: [{ name: 'photo.jpg' }] }),
      },
    });
    expect(getOrchestrationRun(result.runId)?.plan.objective).toBe('Process inbound chat message.');
  });

  it('declares fallback attempts only under an evaluated explicit policy', () => {
    const policy = structuredClone(DEFAULT_ADVANCED_FEATURE_POLICY);
    policy.gates.fallback = {
      enabled: true,
      evaluationId: 'fallback-fixtures-2026-07-01',
      evaluatedPolicyVersion: policy.version,
    };
    policy.fallbackCandidates = ['backup'];
    const result = dispatchDirectExecution({
      taskId: 'fallback-enabled',
      objective: 'analyze',
      agentGroupId: 'agent',
      sessionId: 'session',
      advancedPolicy: policy,
      message: {
        id: 'fallback-enabled:agent',
        kind: 'chat',
        timestamp: '2026-01-01T00:00:00.000Z',
        content: JSON.stringify({ text: 'analyze' }),
      },
    });
    const run = getOrchestrationRun(result.runId)!;
    expect(run.plan.steps[0]).toMatchObject({ onFailure: 'fallback', retry: { maxAttempts: 2 } });
    expect(run.plan.metadata.policyVersion).toBe(policy.version);
  });
});
