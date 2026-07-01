import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activateVerifiedToolStrategy,
  providerToolFingerprint,
  createProviderProfile,
} from '../db/provider-profiles.js';
import {
  closeDb,
  createAgentGroup,
  createContainerConfig,
  createSession,
  initTestDb,
  runMigrations,
} from '../db/index.js';
import { getSession } from '../db/sessions.js';
import { compileDirectPlan } from './patterns/direct.js';
import { DEFAULT_ADVANCED_FEATURE_POLICY } from './advanced-feature-policy.js';
import {
  maybeDispatchFallback,
  recoverFallbackDispatches,
  resolveFallbackCandidate,
  type FallbackSourceMessage,
} from './fallback-dispatcher.js';
import {
  createOrchestrationRun,
  directDeliveryDecision,
  getOrchestrationRun,
  getStepAttempts,
  markRunDispatched,
  recordActiveAttemptRuntimeFacts,
  recordModelBatchResult,
  requestOrchestrationCancellation,
} from './run-store.js';

function activePolicy() {
  const policy = structuredClone(DEFAULT_ADVANCED_FEATURE_POLICY);
  policy.gates.fallback = {
    enabled: true,
    evaluationId: 'fallback-fixtures-2026-07-01',
    evaluatedPolicyVersion: policy.version,
  };
  policy.fallbackCandidates = ['backup'];
  return policy;
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'agent', name: 'Agent', folder: 'agent', agent_provider: null, created_at: '2026-01-01' });
  createContainerConfig({
    agent_group_id: 'agent',
    provider_profile_id: null,
    provider: 'openai-compatible',
    model: null,
    effort: null,
    image_tag: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    skills: '[]',
    mcp_servers: '{}',
    packages_apt: '[]',
    packages_npm: '[]',
    additional_mounts: '[]',
    cli_scope: 'group',
    shared_resources: '[]',
    updated_at: '2026-01-01',
  });
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
  const profile = createProviderProfile({
    id: 'backup',
    name: 'Backup',
    providerName: 'openai-compatible',
    baseUrl: 'https://backup.example.test/v1',
    apiFamily: 'responses',
    defaultModel: 'backup-model',
    authMode: 'none',
  });
  activateVerifiedToolStrategy('backup', 'native', {
    profileId: profile.id,
    fingerprint: providerToolFingerprint(profile),
    verifiedAt: '2026-01-01T00:00:00.000Z',
    ok: true,
  });
});
afterEach(closeDb);

function failedSource() {
  const plan = compileDirectPlan({
    taskId: 'fallback-dispatch',
    objective: 'analyze this',
    kind: 'chat',
    agentGroupId: 'agent',
    sessionId: 'session',
    createdAt: new Date().toISOString(),
  });
  plan.assessment.taskClass = 'analysis';
  plan.steps[0].onFailure = 'fallback';
  plan.steps[0].retry.maxAttempts = 2;
  plan.budgets.maxAttemptsPerStep = 2;
  const run = createOrchestrationRun(plan, 'input:fallback');
  const initial = getStepAttempts(run.run_id)[0];
  const candidate = resolveFallbackCandidate(run, initial, 'backup', true);
  recordActiveAttemptRuntimeFacts('session', {
    ...candidate.runtimeFacts,
    endpointProfileId: 'primary',
  });
  markRunDispatched(run.run_id);
  return recordModelBatchResult({
    eventId: 'primary-failed',
    sourceSessionId: 'session',
    inputMessageIds: ['input:fallback'],
    outcome: 'terminal-error',
    usage: { inputTokens: 10, estimatedCostUsd: 0.01, source: 'provider' },
    error: { classification: 'transient', retryable: true, sideEffectBoundaryCrossed: false },
  })[0];
}

const message: FallbackSourceMessage = {
  id: 'input:fallback',
  kind: 'chat',
  timestamp: '2026-01-01T00:00:00.000Z',
  platform_id: 'chat',
  channel_type: 'telegram',
  thread_id: null,
  content: JSON.stringify({ text: 'analyze this' }),
  source_session_id: null,
};

describe('fallback dispatcher', () => {
  it('revalidates, creates an isolated provider session, and suppresses the primary error', async () => {
    const source = failedSource();
    const written: Array<{ sessionId: string; message: Record<string, unknown> }> = [];
    const wake = vi.fn(async () => true);
    const stopSource = vi.fn();
    const attempt = await maybeDispatchFallback(source, activePolicy(), {
      verifyProfile: async () => ({
        ok: true,
        reachable: true,
        authenticated: true,
        modelAccepted: true,
        protocolAccepted: true,
      }),
      readMessage: () => message,
      initSession: () => undefined,
      writeMessage: (_agentGroupId, sessionId, input) => {
        written.push({ sessionId, message: input });
        return true;
      },
      wake,
      stopSource,
    });
    expect(attempt).toMatchObject({
      attempt: 2,
      status: 'running',
      endpoint_profile_id: 'backup',
      runtime_id: 'openai-protocol-loop',
    });
    expect(attempt?.execution_session_id).toMatch(/^fallback-/);
    expect(getSession(attempt!.execution_session_id!)).toMatchObject({
      provider_profile_id: 'backup',
      messaging_group_id: null,
    });
    expect(written[0]).toMatchObject({
      sessionId: attempt!.execution_session_id,
      message: { id: message.id, orchestrationRunId: source.run_id },
    });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(stopSource).toHaveBeenCalledWith('session', source.run_id);
    expect(directDeliveryDecision('session', message.id)).toMatchObject({ state: 'suppress' });
    expect(directDeliveryDecision(attempt!.execution_session_id!, message.id)).toMatchObject({ state: 'wait' });
    expect(getOrchestrationRun(source.run_id)?.status).toBe('running');
    recordModelBatchResult({
      eventId: 'fallback-succeeded',
      sourceSessionId: attempt!.execution_session_id!,
      inputMessageIds: [message.id],
      outcome: 'result',
      usage: { inputTokens: 20, outputTokens: 5, estimatedCostUsd: 0.02, source: 'provider' },
    });
    expect(getOrchestrationRun(source.run_id)?.usage).toMatchObject({
      inputTokens: 30,
      outputTokens: 5,
      estimatedCostUsd: 0.03,
    });
  });

  it('fails closed for attachment-backed input before creating a fallback attempt', async () => {
    const source = failedSource();
    await expect(
      maybeDispatchFallback(source, activePolicy(), {
        verifyProfile: async () => ({
          ok: true,
          reachable: true,
          authenticated: true,
          modelAccepted: true,
          protocolAccepted: true,
        }),
        readMessage: () => ({
          ...message,
          content: JSON.stringify({ attachments: [{ localPath: '/workspace/inbox/file' }] }),
        }),
        initSession: () => undefined,
        writeMessage: () => true,
        wake: async () => true,
      }),
    ).resolves.toBeUndefined();
    expect(getStepAttempts(source.run_id)).toHaveLength(2);
    expect(getOrchestrationRun(source.run_id)?.status).toBe('failed');
  });

  it('recovers once after failure persistence and remains idempotent', async () => {
    const source = failedSource();
    const wake = vi.fn(async () => true);
    const dependencies = {
      verifyProfile: async () => ({
        ok: true,
        reachable: true,
        authenticated: true,
        modelAccepted: true,
        protocolAccepted: true,
      }),
      readMessage: () => message,
      initSession: () => undefined,
      writeMessage: () => true,
      wake,
    };
    await expect(recoverFallbackDispatches(activePolicy(), dependencies)).resolves.toEqual({
      recovered: 1,
      failed: 0,
    });
    await expect(recoverFallbackDispatches(activePolicy(), dependencies)).resolves.toEqual({
      recovered: 0,
      failed: 0,
    });
    expect(getStepAttempts(source.run_id).filter((attempt) => attempt.kind === 'model')).toHaveLength(2);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('returns the fallback lease to queued when container startup fails', async () => {
    const source = failedSource();
    const dependencies = {
      verifyProfile: async () => ({
        ok: true,
        reachable: true,
        authenticated: true,
        modelAccepted: true,
        protocolAccepted: true,
      }),
      readMessage: () => message,
      initSession: () => undefined,
      writeMessage: () => true,
      wake: vi.fn(async () => false),
    };

    await expect(maybeDispatchFallback(source, activePolicy(), dependencies)).rejects.toThrow(
      'Fallback session wake failed',
    );
    expect(getStepAttempts(source.run_id).find((attempt) => attempt.attempt === 2)).toMatchObject({
      status: 'queued',
      lease_owner: null,
      lease_expires_at: null,
    });

    dependencies.wake.mockResolvedValue(true);
    await expect(maybeDispatchFallback(source, activePolicy(), dependencies)).resolves.toMatchObject({
      attempt: 2,
      status: 'running',
    });
  });

  it('does not resolve or dispatch a candidate after cancellation', async () => {
    const source = failedSource();
    requestOrchestrationCancellation({ runId: source.run_id });
    const verifyProfile = vi.fn();
    await expect(
      maybeDispatchFallback(source, activePolicy(), {
        verifyProfile,
        readMessage: () => message,
        initSession: () => undefined,
        writeMessage: () => true,
        wake: async () => true,
      }),
    ).resolves.toBeUndefined();
    expect(verifyProfile).not.toHaveBeenCalled();
    expect(getStepAttempts(source.run_id).filter((attempt) => attempt.kind === 'model')).toHaveLength(1);
  });
});
