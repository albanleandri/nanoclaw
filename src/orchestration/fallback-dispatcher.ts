import { createHash } from 'crypto';

import { compileEffectiveSessionPlan } from '../capabilities/compile-session-plan.js';
import { configFromDb } from '../container-config.js';
import { isContainerRunning, killContainer, wakeContainer } from '../container-runner.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getContainerConfig } from '../db/container-configs.js';
import { getProviderProfile } from '../db/provider-profiles.js';
import { createSession, getSession } from '../db/sessions.js';
import { resolveEffectiveProviderConfig } from '../providers/effective-provider.js';
import { resolveEffectiveRuntimeSelection } from '../providers/effective-runtime.js';
import {
  getRuntimeDescriptorByContainerFactory,
  requireRuntimeDescriptor,
} from '../providers/runtime-descriptor-registry.js';
import { verifyProviderProfile, type ProviderVerifyResult } from '../providers/provider-verifier-registry.js';
import { initSessionFolder, openInboundDb, writeSessionMessageIfAbsent } from '../session-manager.js';
import type { ProviderProfileRow, Session } from '../types.js';
import {
  ACTIVE_ADVANCED_FEATURE_POLICY,
  advancedFeatureEnabled,
  type AdvancedFeaturePolicy,
} from './advanced-feature-policy.js';
import {
  evaluateFallback,
  type FallbackAttemptFacts,
  type FallbackCandidate,
  type FallbackDecision,
  type FallbackFailureClass,
} from './fallback-policy.js';
import { capabilityFingerprint, toolSchemaFingerprint } from './invocation-fingerprint.js';
import {
  bindFallbackExecutionSession,
  getOrchestrationRun,
  leaseReadyStep,
  listRecoverableFallbackSources,
  persistFallbackDecision,
  queueApprovedFallbackAttempt,
  releaseStepLease,
  type AttemptRuntimeFacts,
  type OrchestrationRun,
  type StepAttempt,
} from './run-store.js';

interface CandidateResolution {
  profile: ProviderProfileRow;
  candidate: FallbackCandidate;
  runtimeFacts: AttemptRuntimeFacts;
}

export interface FallbackSourceMessage {
  id: string;
  kind: string;
  timestamp: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  source_session_id: string | null;
}

export interface FallbackDispatcherDependencies {
  verifyProfile(profile: ProviderProfileRow, options: { agentGroupId: string }): Promise<ProviderVerifyResult>;
  wake(session: Session): Promise<boolean>;
  readMessage(run: OrchestrationRun, source: StepAttempt): FallbackSourceMessage;
  initSession(agentGroupId: string, sessionId: string): void;
  writeMessage(
    agentGroupId: string,
    sessionId: string,
    message: Parameters<typeof writeSessionMessageIfAbsent>[2],
  ): boolean;
  stopSource(sessionId: string, runId: string): void;
}

const DEFAULT_DEPS: FallbackDispatcherDependencies = {
  verifyProfile: (profile, options) => verifyProviderProfile(profile, options),
  wake: wakeContainer,
  readMessage: readSourceMessage,
  initSession: initSessionFolder,
  writeMessage: writeSessionMessageIfAbsent,
  stopSource: (sessionId, runId) => {
    if (isContainerRunning(sessionId)) {
      killContainer(sessionId, `orchestration-fallback:${runId}`);
    }
  },
};

function requiredCapabilities(run: OrchestrationRun, stepId: string): string[] {
  const step = run.plan.steps.find((item) => item.id === stepId);
  if (!step) throw new Error(`Fallback step not found: ${stepId}`);
  const role = step.roleId ? run.plan.roles.find((item) => item.id === step.roleId) : undefined;
  return [...new Set([...(role?.requiredCapabilities ?? []), ...step.requiredCapabilities])].sort();
}

export function resolveFallbackCandidate(
  run: OrchestrationRun,
  source: StepAttempt,
  profileId: string,
  credentialsAvailable: boolean,
): CandidateResolution {
  const profile = getProviderProfile(profileId);
  if (!profile || profile.enabled !== 1) throw new Error(`Fallback provider profile unavailable: ${profileId}`);
  const group = getAgentGroup(run.agent_group_id);
  const configRow = getContainerConfig(run.agent_group_id);
  if (!group || !configRow) throw new Error(`Fallback agent group configuration unavailable: ${run.agent_group_id}`);
  const config = configFromDb(configRow, group);
  config.providerProfileId = profile.id;
  const effective = resolveEffectiveProviderConfig({ agent_provider: null, provider_profile_id: profile.id }, config);
  const runtime = resolveEffectiveRuntimeSelection(effective);
  const descriptor = getRuntimeDescriptorByContainerFactory(effective.provider);
  if (!descriptor || descriptor.id !== runtime.runtimeId) throw new Error('Fallback runtime resolution mismatch');
  const planned = compileEffectiveSessionPlan({
    config,
    effectiveProvider: effective,
    runtime,
    runtimeDescriptor: descriptor,
    requiredCapabilities: requiredCapabilities(run, source.step_id),
  });
  const capabilityHash = capabilityFingerprint(planned.compiledPlan);
  const schemaHash = toolSchemaFingerprint(planned.compiledPlan);
  return {
    profile,
    candidate: {
      id: profile.id,
      runtimeKind: descriptor.kind,
      protocol: effective.profile?.protocol ?? descriptor.acceptedProtocols[0],
      continuation: descriptor.stateSemantics.continuation,
      capabilityFingerprint: capabilityHash,
      toolSchemaFingerprint: schemaHash,
      credentialsAvailable,
    },
    runtimeFacts: {
      runtimeId: runtime.runtimeId,
      endpointProfileId: profile.id,
      protocol: effective.profile?.protocol ?? descriptor.acceptedProtocols[0],
      continuationSemantics: descriptor.stateSemantics.continuation,
      capabilityFingerprint: capabilityHash,
      toolSchemaFingerprint: schemaHash,
      inputReconstructable:
        descriptor.kind === 'protocol-loop' && descriptor.stateSemantics.continuation === 'transcript',
    },
  };
}

function sourceFacts(source: StepAttempt, inputReconstructable: boolean): FallbackAttemptFacts {
  if (!source.runtime_id || !source.protocol || !source.continuation_semantics) {
    throw new Error('Source attempt has incomplete runtime facts');
  }
  const descriptor = requireRuntimeDescriptor(source.runtime_id);
  return {
    runtimeKind: descriptor.kind,
    protocol: source.protocol as FallbackAttemptFacts['protocol'],
    continuation: source.continuation_semantics as FallbackAttemptFacts['continuation'],
    capabilityFingerprint: source.capability_fingerprint ?? '',
    toolSchemaFingerprint: source.tool_schema_fingerprint ?? '',
    inputReconstructable: source.input_reconstructable === 1 && inputReconstructable,
    sideEffectBoundaryCrossed:
      source.side_effect_boundary_crossed === null ? null : source.side_effect_boundary_crossed === 1,
    resultEmitted: source.result_emitted === 1,
    artifactEmitted: source.artifact_emitted === 1,
    deliveryEmitted: source.delivery_emitted === 1,
  };
}

function readSourceMessage(run: OrchestrationRun, source: StepAttempt): FallbackSourceMessage {
  if (!source.input_message_id) throw new Error('Fallback source attempt has no input message');
  const sourceSessionId = source.execution_session_id ?? run.session_id;
  const db = openInboundDb(run.agent_group_id, sourceSessionId);
  try {
    const row = db
      .prepare(
        `SELECT id, kind, timestamp, platform_id, channel_type, thread_id, content, source_session_id
         FROM messages_in WHERE id=?`,
      )
      .get(source.input_message_id) as FallbackSourceMessage | undefined;
    if (!row) throw new Error(`Fallback source message not found: ${source.input_message_id}`);
    return row;
  } finally {
    db.close();
  }
}

function reconstructableMessage(message: FallbackSourceMessage): boolean {
  try {
    const content = JSON.parse(message.content) as unknown;
    const visit = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return true;
      if (Array.isArray(value)) return value.every(visit);
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'localPath' || key === 'data') return false;
        if (!visit(item)) return false;
      }
      return true;
    };
    return visit(content);
    // Plain-text session messages are reconstructable.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return true;
  }
}

function budget(run: OrchestrationRun, source: StepAttempt) {
  const elapsedMs = Math.max(0, Date.now() - Date.parse(run.created_at));
  return {
    nextAttempt: source.attempt + 1,
    elapsedMs,
    usedTokens: (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0),
    estimatedCostUsd: run.usage?.estimatedCostUsd ?? 0,
  };
}

function decisionId(source: StepAttempt, profileId: string, policyVersion: string): string {
  const suffix = createHash('sha256').update(`${profileId}\0${policyVersion}`).digest('hex').slice(0, 24);
  return `${source.attempt_id}:fallback:${suffix}`;
}

function fallbackSessionId(attemptId: string): string {
  return `fallback-${createHash('sha256').update(attemptId).digest('hex').slice(0, 32)}`;
}

async function prepareAndWakeFallback(
  run: OrchestrationRun,
  sourceSessionId: string,
  queued: StepAttempt,
  resolution: CandidateResolution,
  message: FallbackSourceMessage,
  deps: FallbackDispatcherDependencies,
): Promise<StepAttempt> {
  deps.stopSource(sourceSessionId, run.run_id);
  const sessionId = fallbackSessionId(queued.attempt_id);
  let session = getSession(sessionId);
  if (!session) {
    session = {
      id: sessionId,
      agent_group_id: run.agent_group_id,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      provider_profile_id: resolution.profile.id,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    };
    createSession(session);
    deps.initSession(run.agent_group_id, session.id);
  } else if (session.agent_group_id !== run.agent_group_id || session.provider_profile_id !== resolution.profile.id) {
    throw new Error(`Fallback session identity conflict: ${session.id}`);
  }
  const bound = bindFallbackExecutionSession({
    attemptId: queued.attempt_id,
    sessionId: session.id,
    runtimeFacts: resolution.runtimeFacts,
  });
  deps.writeMessage(run.agent_group_id, session.id, {
    id: message.id,
    kind: message.kind,
    timestamp: message.timestamp,
    platformId: message.platform_id,
    channelType: message.channel_type,
    threadId: message.thread_id,
    content: message.content,
    sourceSessionId: message.source_session_id,
    orchestrationRunId: run.run_id,
  });
  const leaseOwner = `session:${session.id}`;
  const leased =
    bound.status === 'queued'
      ? leaseReadyStep({
          runId: run.run_id,
          stepId: bound.step_id,
          owner: leaseOwner,
        })
      : bound;
  try {
    const woke = await deps.wake(session);
    if (!woke) throw new Error(`Fallback session wake failed: ${session.id}`);
  } catch (error) {
    if (leased.status === 'running' && leased.lease_owner === leaseOwner) {
      releaseStepLease({
        attemptId: leased.attempt_id,
        owner: leaseOwner,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
  return leased;
}

export async function maybeDispatchFallback(
  source: StepAttempt,
  policy: AdvancedFeaturePolicy = ACTIVE_ADVANCED_FEATURE_POLICY,
  dependencies: Partial<FallbackDispatcherDependencies> = {},
): Promise<StepAttempt | undefined> {
  if (!advancedFeatureEnabled(policy, 'fallback') || source.status !== 'failed') return undefined;
  const deps = { ...DEFAULT_DEPS, ...dependencies };
  const run = getOrchestrationRun(source.run_id);
  if (!run || run.cancel_requested_at) return undefined;
  const message = deps.readMessage(run, source);
  const sourceIsReconstructable = reconstructableMessage(message);
  for (const configuredProfileId of policy.fallbackCandidates) {
    let resolution: CandidateResolution;
    try {
      resolution = resolveFallbackCandidate(run, source, configuredProfileId, false);
      const verification = await deps.verifyProfile(resolution.profile, { agentGroupId: run.agent_group_id });
      resolution = resolveFallbackCandidate(
        run,
        source,
        configuredProfileId,
        verification.ok &&
          verification.reachable &&
          verification.authenticated &&
          verification.modelAccepted &&
          verification.protocolAccepted,
      );
      // Resolution/probe failures are durable candidate rejections.
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (error) {
      const candidate: FallbackCandidate = {
        id: configuredProfileId,
        runtimeKind: 'native-harness',
        protocol: 'native',
        continuation: 'runtime-thread',
        capabilityFingerprint: '',
        toolSchemaFingerprint: '',
        credentialsAvailable: false,
      };
      persistFallbackDecision({
        decisionId: decisionId(source, configuredProfileId, policy.version),
        runId: run.run_id,
        stepId: source.step_id,
        sourceAttempt: source.attempt,
        decision: {
          allowed: false,
          candidateId: configuredProfileId,
          policyVersion: policy.version,
          reasons: [
            `candidate_resolution_failed:${(error instanceof Error ? error.message : 'unknown').slice(0, 512)}`,
          ],
        },
        candidate,
      });
      continue;
    }
    const limits = budget(run, source);
    const decision: FallbackDecision = evaluateFallback({
      policy,
      taskClass: run.plan.assessment.taskClass,
      role: 'main',
      failure: {
        classification: (source.error_class ?? 'unknown') as FallbackFailureClass,
        retryable: source.error_retryable === 1,
      },
      attempt: sourceFacts(source, sourceIsReconstructable),
      candidate: resolution.candidate,
      budget: limits,
    });
    const id = decisionId(source, resolution.candidate.id, policy.version);
    persistFallbackDecision({
      decisionId: id,
      runId: run.run_id,
      stepId: source.step_id,
      sourceAttempt: source.attempt,
      decision,
      candidate: resolution.candidate,
    });
    if (!decision.allowed) continue;
    const queued = queueApprovedFallbackAttempt({
      decisionId: id,
      runId: run.run_id,
      stepId: source.step_id,
      sourceAttempt: source.attempt,
    });
    return prepareAndWakeFallback(
      run,
      source.execution_session_id ?? run.session_id,
      queued,
      resolution,
      message,
      deps,
    );
  }
  return undefined;
}

export async function recoverFallbackDispatches(
  policy: AdvancedFeaturePolicy = ACTIVE_ADVANCED_FEATURE_POLICY,
  dependencies: Partial<FallbackDispatcherDependencies> = {},
): Promise<{ recovered: number; failed: number }> {
  if (!advancedFeatureEnabled(policy, 'fallback')) return { recovered: 0, failed: 0 };
  let recovered = 0;
  let failed = 0;
  for (const source of listRecoverableFallbackSources(20)) {
    try {
      if (await maybeDispatchFallback(source, policy, dependencies)) recovered++;
      // A later sweep retries durable eligible state.
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      failed++;
    }
  }
  return { recovered, failed };
}
