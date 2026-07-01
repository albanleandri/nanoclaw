import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, createSession, getDb, initTestDb, runMigrations } from '../db/index.js';
import { compileDirectPlan } from './patterns/direct.js';
import { DEFAULT_ADVANCED_FEATURE_POLICY } from './advanced-feature-policy.js';
import { evaluateFallback, stableFingerprint } from './fallback-policy.js';
import {
  authorizeCorrelatedHostAction,
  createOrchestrationRun,
  directDeliveryDecision,
  getReadyStepAttempts,
  getRequiredCapabilitiesForSession,
  getOrchestrationRun,
  getStepAttempts,
  markRunDispatched,
  persistFallbackDecision,
  queueApprovedFallbackAttempt,
  recordActiveAttemptRuntimeFacts,
  recordDirectDelivery,
  recordModelBatchResult,
  recordSessionCapabilityAuthorization,
  recoverOrchestrationRuns,
  requestOrchestrationCancellation,
} from './run-store.js';

beforeEach(() => {
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

function createRun(requiredCapabilities: string[] = [], taskId = 'message:agent') {
  const plan = compileDirectPlan({
    taskId,
    objective: 'hello',
    kind: 'chat',
    agentGroupId: 'agent',
    sessionId: 'session',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  plan.roles[0].requiredCapabilities = requiredCapabilities;
  return createOrchestrationRun(plan, `input:${taskId}`);
}

describe('orchestration run store', () => {
  it('leases dependency-ready work and gates delivery until the model is terminal', () => {
    const run = createRun();
    expect(getReadyStepAttempts(run.run_id).map((attempt) => attempt.step_id)).toEqual(['model']);
    markRunDispatched(run.run_id);
    expect(getStepAttempts(run.run_id)[0]).toMatchObject({
      status: 'running',
      lease_owner: 'session:session',
    });
    expect(directDeliveryDecision('session', 'input:message:agent')).toMatchObject({ state: 'wait' });

    recordModelBatchResult({
      eventId: 'result-event',
      sourceSessionId: 'session',
      inputMessageIds: ['input:message:agent'],
      outcome: 'result',
      usage: { inputTokens: 10, outputTokens: 2, source: 'provider' },
    });
    expect(getReadyStepAttempts(run.run_id).map((attempt) => attempt.step_id)).toEqual(['delivery']);
    expect(directDeliveryDecision('session', 'input:message:agent')).toMatchObject({ state: 'allow' });
    recordDirectDelivery({
      sourceSessionId: 'session',
      inputMessageId: 'input:message:agent',
      outboundMessageId: 'out',
      status: 'succeeded',
    });
    expect(getOrchestrationRun(run.run_id)).toMatchObject({
      status: 'succeeded',
      usage: { inputTokens: 10, outputTokens: 2, source: 'provider' },
    });
    expect(getStepAttempts(run.run_id).map((attempt) => attempt.status)).toEqual(['succeeded', 'succeeded']);
    expect(getRequiredCapabilitiesForSession('session')).toEqual([]);
  });

  it('atomically rolls back attempt and run state when lease event persistence fails', () => {
    const run = createRun([], 'atomic-lease');
    getDb().exec(`
      CREATE TRIGGER reject_step_lease_event
      BEFORE INSERT ON orchestration_events
      WHEN NEW.event_type='step_leased'
      BEGIN
        SELECT RAISE(ABORT, 'injected event failure');
      END;
    `);

    expect(() => markRunDispatched(run.run_id)).toThrow('injected event failure');
    expect(getOrchestrationRun(run.run_id)?.status).toBe('queued');
    expect(getStepAttempts(run.run_id)[0]).toMatchObject({
      status: 'queued',
      lease_owner: null,
      lease_expires_at: null,
    });
  });

  it('is idempotent and derives source session identity', () => {
    const run = createRun();
    expect(createRun().run_id).toBe(run.run_id);
    markRunDispatched(run.run_id);
    recordModelBatchResult({
      eventId: 'spoof',
      sourceSessionId: 'other-session',
      inputMessageIds: ['input:message:agent'],
      outcome: 'result',
    });
    expect(getOrchestrationRun(run.run_id)?.status).toBe('running');
  });

  it('attributes one delivered batch response to every model input in that batch', () => {
    const first = createRun([], 'batch-a');
    const second = createRun([], 'batch-b');
    markRunDispatched(first.run_id);
    markRunDispatched(second.run_id);
    recordModelBatchResult({
      eventId: 'batch-result',
      sourceSessionId: 'session',
      inputMessageIds: ['input:batch-a', 'input:batch-b'],
      outcome: 'result',
    });
    recordDirectDelivery({
      sourceSessionId: 'session',
      inputMessageId: 'input:batch-a',
      outboundMessageId: 'batch-output',
      status: 'succeeded',
    });
    expect(getOrchestrationRun(first.run_id)?.status).toBe('succeeded');
    expect(getOrchestrationRun(second.run_id)?.status).toBe('succeeded');
  });

  it('feeds active step requirements into SessionRuntimePlan compilation', () => {
    createRun(['memory.session-search']);
    expect(getRequiredCapabilitiesForSession('session')).toEqual(['memory.session-search']);
  });

  it('persists immutable runtime compatibility facts on the active attempt', () => {
    const run = createRun([], 'runtime-facts');
    const fingerprint = stableFingerprint([]);
    expect(
      recordActiveAttemptRuntimeFacts('session', {
        runtimeId: 'openai-protocol-loop',
        endpointProfileId: 'primary',
        protocol: 'openai-compatible',
        continuationSemantics: 'transcript',
        capabilityFingerprint: fingerprint,
        toolSchemaFingerprint: fingerprint,
        inputReconstructable: true,
      }),
    ).toBe(1);
    expect(getStepAttempts(run.run_id)[0]).toMatchObject({
      runtime_id: 'openai-protocol-loop',
      endpoint_profile_id: 'primary',
      side_effect_boundary_crossed: null,
      input_reconstructable: 1,
    });
    expect(
      recordActiveAttemptRuntimeFacts('session', {
        runtimeId: 'different',
        protocol: 'native',
        continuationSemantics: 'runtime-thread',
        capabilityFingerprint: 'different',
        toolSchemaFingerprint: 'different',
        inputReconstructable: false,
      }),
    ).toBe(0);
  });

  it('queues one idempotent fallback attempt only from a durable approved decision', () => {
    const plan = compileDirectPlan({
      taskId: 'fallback',
      objective: 'hello',
      kind: 'chat',
      agentGroupId: 'agent',
      sessionId: 'session',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    plan.steps[0].onFailure = 'fallback';
    plan.steps[0].retry.maxAttempts = 2;
    plan.budgets.maxAttemptsPerStep = 2;
    const run = createOrchestrationRun(plan, 'input:fallback');
    const fingerprint = stableFingerprint([]);
    recordActiveAttemptRuntimeFacts('session', {
      runtimeId: 'openai-protocol-loop',
      endpointProfileId: 'primary',
      protocol: 'openai-compatible',
      continuationSemantics: 'transcript',
      capabilityFingerprint: fingerprint,
      toolSchemaFingerprint: fingerprint,
      inputReconstructable: true,
    });
    markRunDispatched(run.run_id);
    recordModelBatchResult({
      eventId: 'fallback-failure',
      sourceSessionId: 'session',
      inputMessageIds: ['input:fallback'],
      outcome: 'terminal-error',
      error: { classification: 'transient', retryable: true, sideEffectBoundaryCrossed: false },
    });
    const policy = structuredClone(DEFAULT_ADVANCED_FEATURE_POLICY);
    policy.gates.fallback = {
      enabled: true,
      evaluationId: 'fallback-fixtures-2026-07-01',
      evaluatedPolicyVersion: policy.version,
    };
    policy.fallbackCandidates = ['backup'];
    const candidate = {
      id: 'backup',
      runtimeKind: 'protocol-loop' as const,
      protocol: 'openai-compatible' as const,
      continuation: 'transcript' as const,
      capabilityFingerprint: fingerprint,
      toolSchemaFingerprint: fingerprint,
      credentialsAvailable: true,
    };
    const decision = evaluateFallback({
      policy,
      taskClass: 'analysis',
      role: 'auxiliary-read-only',
      failure: { classification: 'transient', retryable: true },
      attempt: {
        runtimeKind: 'protocol-loop',
        protocol: 'openai-compatible',
        continuation: 'transcript',
        capabilityFingerprint: fingerprint,
        toolSchemaFingerprint: fingerprint,
        inputReconstructable: true,
        sideEffectBoundaryCrossed: false,
        resultEmitted: false,
        artifactEmitted: false,
        deliveryEmitted: false,
      },
      candidate,
      budget: { nextAttempt: 2, elapsedMs: 10, usedTokens: 0, estimatedCostUsd: 0 },
    });
    persistFallbackDecision({
      decisionId: 'decision:fallback',
      runId: run.run_id,
      stepId: 'model',
      sourceAttempt: 1,
      decision,
      candidate,
    });
    const queued = queueApprovedFallbackAttempt({
      decisionId: 'decision:fallback',
      runId: run.run_id,
      stepId: 'model',
      sourceAttempt: 1,
    });
    expect(queued).toMatchObject({ attempt: 2, status: 'queued', endpoint_profile_id: 'backup' });
    expect(
      queueApprovedFallbackAttempt({
        decisionId: 'decision:fallback',
        runId: run.run_id,
        stepId: 'model',
        sourceAttempt: 1,
      }).attempt_id,
    ).toBe(queued.attempt_id);
    expect(getOrchestrationRun(run.run_id)?.status).toBe('running');
  });

  it('authorizes correlated host actions only while the model lease is active', () => {
    const run = createRun([], 'host-action');
    markRunDispatched(run.run_id);
    recordSessionCapabilityAuthorization('session', ['nanoclaw.schedule-task']);
    expect(
      authorizeCorrelatedHostAction({
        sourceSessionId: 'session',
        inputMessageId: 'input:host-action',
        outboundMessageId: 'out:action',
        action: 'schedule_task',
      }),
    ).toEqual({ correlated: true, runId: run.run_id });
    requestOrchestrationCancellation({ runId: run.run_id, reason: 'stop' });
    expect(() =>
      authorizeCorrelatedHostAction({
        sourceSessionId: 'session',
        inputMessageId: 'input:host-action',
        outboundMessageId: 'out:late',
        action: 'schedule_task',
      }),
    ).toThrow(/inactive run/);
  });

  it('requires known host actions to be present in the compiled session capability snapshot', () => {
    const run = createRun([], 'capability-denied');
    markRunDispatched(run.run_id);
    recordSessionCapabilityAuthorization('session', []);
    expect(() =>
      authorizeCorrelatedHostAction({
        sourceSessionId: 'session',
        inputMessageId: 'input:capability-denied',
        outboundMessageId: 'out:denied',
        action: 'schedule_task',
      }),
    ).toThrow(/nanoclaw.schedule-task/);
  });

  it('propagates cancellation and ignores late runner results', () => {
    const run = createRun([], 'cancel');
    markRunDispatched(run.run_id);
    requestOrchestrationCancellation({ runId: run.run_id, agentGroupId: 'agent', reason: 'user stopped' });
    expect(getOrchestrationRun(run.run_id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'user stopped',
    });
    expect(getStepAttempts(run.run_id).map((attempt) => attempt.status)).toEqual(['cancelled', 'cancelled']);
    expect(directDeliveryDecision('session', 'input:cancel')).toMatchObject({ state: 'suppress' });
    recordModelBatchResult({
      eventId: 'late',
      sourceSessionId: 'session',
      inputMessageIds: ['input:cancel'],
      outcome: 'result',
    });
    expect(getOrchestrationRun(run.run_id)?.status).toBe('cancelled');
  });

  it('recovers expired leases and wall-clock budgets idempotently', () => {
    const leased = createRun([], 'leased');
    markRunDispatched(leased.run_id);
    const leaseExpiry = getStepAttempts(leased.run_id)[0].lease_expires_at!;
    expect(recoverOrchestrationRuns(new Date(Date.parse(leaseExpiry) + 1).toISOString())).toEqual({
      expiredLeases: 1,
      expiredRuns: 0,
    });
    expect(getOrchestrationRun(leased.run_id)?.status).toBe('failed');

    const timedOut = createRun([], 'timeout');
    expect(recoverOrchestrationRuns('2026-01-01T00:35:00.001Z')).toEqual({
      expiredLeases: 0,
      expiredRuns: 1,
    });
    expect(getOrchestrationRun(timedOut.run_id)?.status).toBe('failed');
    expect(recoverOrchestrationRuns('2026-01-01T00:36:00.000Z')).toEqual({
      expiredLeases: 0,
      expiredRuns: 0,
    });
  });
});
