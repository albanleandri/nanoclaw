import { randomUUID } from 'crypto';

import type { ModelUsage } from '../auxiliary/types.js';
import { listCapabilities } from '../capabilities/capability-registry.js';
import { getDb } from '../db/connection.js';
import '../providers/runtime-descriptors/index.js';
import { requireRuntimeDescriptor } from '../providers/runtime-descriptor-registry.js';
import type { ExecutionPlan, OrchestrationStatus, StepStatus } from './types.js';
import type { FallbackCandidate, FallbackDecision } from './fallback-policy.js';
import { validateExecutionPlan } from './validate-plan.js';

export interface OrchestrationRun {
  run_id: string;
  plan_id: string;
  task_id: string;
  agent_group_id: string;
  session_id: string;
  pattern_id: string;
  pattern_version: number;
  status: OrchestrationStatus;
  plan: ExecutionPlan;
  usage?: ModelUsage;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  cancel_requested_at: string | null;
  cancel_reason: string | null;
}

export interface StepAttempt {
  attempt_id: string;
  run_id: string;
  step_id: string;
  role_id: string | null;
  kind: string;
  attempt: number;
  status: StepStatus;
  idempotency_key: string;
  input_message_id: string | null;
  usage?: ModelUsage;
  error_class: string | null;
  error_message: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  batch_id: string | null;
  runtime_id: string | null;
  endpoint_profile_id: string | null;
  protocol: string | null;
  continuation_semantics: string | null;
  capability_fingerprint: string | null;
  tool_schema_fingerprint: string | null;
  input_reconstructable: number;
  side_effect_boundary_crossed: number | null;
  result_emitted: number;
  artifact_emitted: number;
  delivery_emitted: number;
  error_retryable: number | null;
  execution_session_id: string | null;
}

export interface AttemptRuntimeFacts {
  runtimeId: string;
  endpointProfileId?: string;
  protocol: string;
  continuationSemantics: string;
  capabilityFingerprint: string;
  toolSchemaFingerprint: string;
  inputReconstructable: boolean;
}

type RunRow = Omit<OrchestrationRun, 'plan' | 'usage'> & { plan_json: string; usage_json: string | null };
type AttemptRow = Omit<StepAttempt, 'usage'> & { usage_json: string | null };

function rowToRun(row: RunRow): OrchestrationRun {
  return {
    ...row,
    plan: JSON.parse(row.plan_json) as ExecutionPlan,
    ...(row.usage_json ? { usage: JSON.parse(row.usage_json) as ModelUsage } : {}),
  };
}

function rowToAttempt(row: AttemptRow): StepAttempt {
  return {
    ...row,
    ...(row.usage_json ? { usage: JSON.parse(row.usage_json) as ModelUsage } : {}),
  };
}

function appendEvent(input: {
  eventId: string;
  runId: string;
  eventType: string;
  stepId?: string;
  attempt?: number;
  data?: unknown;
  createdAt: string;
}): void {
  const db = getDb();
  const seq = (
    db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM orchestration_events WHERE run_id = ?')
      .get(input.runId) as {
      seq: number;
    }
  ).seq;
  db.prepare(
    `INSERT OR IGNORE INTO orchestration_events
     (event_id, run_id, seq, event_type, step_id, attempt, data_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.eventId,
    input.runId,
    seq,
    input.eventType,
    input.stepId ?? null,
    input.attempt ?? null,
    input.data === undefined ? null : JSON.stringify(input.data),
    input.createdAt,
  );
}

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

export function getOrchestrationRun(runId: string): OrchestrationRun | undefined {
  const row = getDb().prepare('SELECT * FROM orchestration_runs WHERE run_id = ?').get(runId) as RunRow | undefined;
  return row ? rowToRun(row) : undefined;
}

export function getOrchestrationRunByPlan(planId: string): OrchestrationRun | undefined {
  const row = getDb().prepare('SELECT * FROM orchestration_runs WHERE plan_id = ?').get(planId) as RunRow | undefined;
  return row ? rowToRun(row) : undefined;
}

export function listOrchestrationRuns(input: {
  agentGroupId: string;
  status?: OrchestrationStatus;
  limit?: number;
}): Array<Omit<OrchestrationRun, 'plan'>> {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const rows = getDb()
    .prepare(
      `SELECT * FROM orchestration_runs
       WHERE agent_group_id=@agentGroupId
         AND (@status IS NULL OR status=@status)
       ORDER BY created_at DESC LIMIT @limit`,
    )
    .all({ agentGroupId: input.agentGroupId, status: input.status ?? null, limit }) as RunRow[];
  return rows.map((row) => {
    const { plan: _plan, ...run } = rowToRun(row);
    return run;
  });
}

export function getRequiredCapabilitiesForSession(sessionId: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT r.plan_json FROM orchestration_runs r
       JOIN orchestration_step_attempts a ON a.run_id=r.run_id
       WHERE COALESCE(a.execution_session_id, r.session_id)=?
         AND r.status IN ('queued','running')
         AND a.kind='model'
         AND a.status IN ('queued','running')`,
    )
    .all(sessionId) as Array<{ plan_json: string }>;
  const capabilities = new Set<string>();
  for (const row of rows) {
    const plan = JSON.parse(row.plan_json) as ExecutionPlan;
    const activeRoleIds = new Set(
      plan.steps
        .filter((step) => step.kind === 'model')
        .map((step) => step.roleId)
        .filter(Boolean),
    );
    for (const step of plan.steps) {
      if (step.kind === 'model') for (const capability of step.requiredCapabilities) capabilities.add(capability);
    }
    for (const role of plan.roles) {
      if (activeRoleIds.has(role.id)) for (const capability of role.requiredCapabilities) capabilities.add(capability);
    }
  }
  return [...capabilities].sort();
}

export function recordSessionCapabilityAuthorization(
  sessionId: string,
  capabilities: string[],
  updatedAt = new Date().toISOString(),
): void {
  const session = getDb().prepare('SELECT agent_group_id FROM sessions WHERE id=?').get(sessionId) as
    { agent_group_id: string } | undefined;
  if (!session) throw new Error(`Session not found for capability authorization: ${sessionId}`);
  const normalized = [...new Set(capabilities)].sort();
  getDb()
    .prepare(
      `INSERT INTO orchestration_session_authorizations
       (session_id, agent_group_id, capabilities_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         agent_group_id=excluded.agent_group_id,
         capabilities_json=excluded.capabilities_json,
         updated_at=excluded.updated_at`,
    )
    .run(sessionId, session.agent_group_id, JSON.stringify(normalized), updatedAt);
}

export function getStepAttempts(runId: string): StepAttempt[] {
  return (
    getDb()
      .prepare('SELECT * FROM orchestration_step_attempts WHERE run_id = ? ORDER BY rowid')
      .all(runId) as AttemptRow[]
  ).map(rowToAttempt);
}

export function listRecoverableFallbackSources(limit = 20): StepAttempt[] {
  const bounded = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 20, 100));
  const rows = getDb()
    .prepare(
      `SELECT source.* FROM orchestration_step_attempts source
       JOIN orchestration_runs r ON r.run_id=source.run_id
       LEFT JOIN orchestration_step_attempts next
         ON next.run_id=source.run_id
        AND next.step_id=source.step_id
        AND next.attempt=source.attempt+1
       WHERE source.kind='model' AND source.status='failed'
         AND r.cancel_requested_at IS NULL
         AND r.status IN ('failed','running')
         AND (next.attempt_id IS NULL OR next.status='queued')
         AND (
           NOT EXISTS (
             SELECT 1 FROM orchestration_fallback_decisions d
             WHERE d.run_id=source.run_id AND d.step_id=source.step_id
               AND d.source_attempt=source.attempt
           )
           OR EXISTS (
             SELECT 1 FROM orchestration_fallback_decisions d
             WHERE d.run_id=source.run_id AND d.step_id=source.step_id
               AND d.source_attempt=source.attempt AND d.allowed=1
           )
         )
       ORDER BY source.finished_at, source.attempt_id
       LIMIT ?`,
    )
    .all(bounded) as AttemptRow[];
  return rows.map(rowToAttempt);
}

export function recordActiveAttemptRuntimeFacts(sessionId: string, facts: AttemptRuntimeFacts): number {
  const result = getDb()
    .prepare(
      `UPDATE orchestration_step_attempts
       SET runtime_id=?, endpoint_profile_id=?, protocol=?, continuation_semantics=?,
           capability_fingerprint=?, tool_schema_fingerprint=?, input_reconstructable=?
       WHERE attempt_id IN (
         SELECT a.attempt_id FROM orchestration_step_attempts a
         JOIN orchestration_runs r ON r.run_id=a.run_id
         WHERE COALESCE(a.execution_session_id, r.session_id)=? AND r.status IN ('queued','running')
           AND a.kind='model' AND a.status IN ('queued','running')
       )
       AND runtime_id IS NULL`,
    )
    .run(
      facts.runtimeId,
      facts.endpointProfileId ?? null,
      facts.protocol,
      facts.continuationSemantics,
      facts.capabilityFingerprint,
      facts.toolSchemaFingerprint,
      facts.inputReconstructable ? 1 : 0,
      sessionId,
    );
  return result.changes;
}

export function persistFallbackDecision(input: {
  decisionId: string;
  runId: string;
  stepId: string;
  sourceAttempt: number;
  decision: FallbackDecision;
  candidate: FallbackCandidate;
  createdAt?: string;
}): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO orchestration_fallback_decisions
       (decision_id, run_id, step_id, source_attempt, candidate_id, policy_version,
        allowed, reasons_json, candidate_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.decisionId,
      input.runId,
      input.stepId,
      input.sourceAttempt,
      input.decision.candidateId,
      input.decision.policyVersion,
      input.decision.allowed ? 1 : 0,
      JSON.stringify(input.decision.reasons),
      JSON.stringify(input.candidate),
      input.createdAt ?? new Date().toISOString(),
    );
}

export function queueApprovedFallbackAttempt(input: {
  decisionId: string;
  runId: string;
  stepId: string;
  sourceAttempt: number;
  queuedAt?: string;
}): StepAttempt {
  const now = input.queuedAt ?? new Date().toISOString();
  const db = getDb();
  db.transaction(() => {
    const decision = db
      .prepare(
        `SELECT * FROM orchestration_fallback_decisions
         WHERE decision_id=? AND run_id=? AND step_id=? AND source_attempt=?`,
      )
      .get(input.decisionId, input.runId, input.stepId, input.sourceAttempt) as
      { allowed: number; candidate_id: string; candidate_json: string } | undefined;
    if (!decision || decision.allowed !== 1) throw new Error('Fallback decision is not approved');
    const source = db
      .prepare(
        `SELECT * FROM orchestration_step_attempts
         WHERE run_id=? AND step_id=? AND attempt=?`,
      )
      .get(input.runId, input.stepId, input.sourceAttempt) as AttemptRow | undefined;
    if (!source || source.status !== 'failed') throw new Error('Fallback source attempt is not durably failed');
    const candidate = JSON.parse(decision.candidate_json) as FallbackCandidate;
    const sourceRuntime = source.runtime_id ? requireRuntimeDescriptor(source.runtime_id) : undefined;
    if (
      sourceRuntime?.kind !== 'protocol-loop' ||
      source.input_reconstructable !== 1 ||
      source.side_effect_boundary_crossed !== 0 ||
      source.result_emitted !== 0 ||
      source.artifact_emitted !== 0 ||
      source.delivery_emitted !== 0 ||
      source.protocol !== candidate.protocol ||
      source.capability_fingerprint !== candidate.capabilityFingerprint ||
      source.tool_schema_fingerprint !== candidate.toolSchemaFingerprint ||
      candidate.runtimeKind !== 'protocol-loop' ||
      candidate.continuation === 'runtime-thread'
    ) {
      throw new Error('Durable fallback compatibility or side-effect facts are not clean');
    }
    const run = getOrchestrationRun(input.runId);
    const step = run?.plan.steps.find((item) => item.id === input.stepId);
    const nextAttempt = input.sourceAttempt + 1;
    if (
      !run ||
      run.cancel_requested_at ||
      step?.onFailure !== 'fallback' ||
      nextAttempt > (step?.retry.maxAttempts ?? 0) ||
      nextAttempt > run.plan.budgets.maxAttemptsPerStep
    ) {
      throw new Error('Fallback is not declared or exceeds the plan budget');
    }
    const attemptId = `${input.runId}:${input.stepId}:${nextAttempt}`;
    db.prepare(
      `INSERT OR IGNORE INTO orchestration_step_attempts
       (attempt_id, run_id, step_id, role_id, kind, attempt, status,
        idempotency_key, input_message_id, queued_at, endpoint_profile_id)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
    ).run(
      attemptId,
      input.runId,
      input.stepId,
      source.role_id,
      source.kind,
      nextAttempt,
      attemptId,
      source.input_message_id,
      now,
      decision.candidate_id,
    );
    db.prepare(
      `UPDATE orchestration_runs SET status='running', finished_at=NULL, updated_at=?
       WHERE run_id=? AND status IN ('running','failed')`,
    ).run(now, input.runId);
    appendEvent({
      eventId: `${input.decisionId}:queued`,
      runId: input.runId,
      eventType: 'fallback_queued',
      stepId: input.stepId,
      attempt: nextAttempt,
      data: { sourceAttempt: input.sourceAttempt, candidateId: decision.candidate_id },
      createdAt: now,
    });
  })();
  return getStepAttempts(input.runId).find(
    (attempt) => attempt.step_id === input.stepId && attempt.attempt === input.sourceAttempt + 1,
  )!;
}

export function bindFallbackExecutionSession(input: {
  attemptId: string;
  sessionId: string;
  runtimeFacts: AttemptRuntimeFacts;
}): StepAttempt {
  const result = getDb()
    .prepare(
      `UPDATE orchestration_step_attempts
       SET execution_session_id=?, runtime_id=?, endpoint_profile_id=?,
           protocol=?, continuation_semantics=?, capability_fingerprint=?,
           tool_schema_fingerprint=?, input_reconstructable=?
       WHERE attempt_id=? AND status='queued'
         AND (execution_session_id IS NULL OR execution_session_id=?)`,
    )
    .run(
      input.sessionId,
      input.runtimeFacts.runtimeId,
      input.runtimeFacts.endpointProfileId ?? null,
      input.runtimeFacts.protocol,
      input.runtimeFacts.continuationSemantics,
      input.runtimeFacts.capabilityFingerprint,
      input.runtimeFacts.toolSchemaFingerprint,
      input.runtimeFacts.inputReconstructable ? 1 : 0,
      input.attemptId,
      input.sessionId,
    );
  if (result.changes !== 1) {
    const existing = getDb()
      .prepare('SELECT * FROM orchestration_step_attempts WHERE attempt_id=?')
      .get(input.attemptId) as AttemptRow | undefined;
    if (!existing || existing.execution_session_id !== input.sessionId) {
      throw new Error(`Fallback execution session bind conflict: ${input.attemptId}`);
    }
  }
  const attempt = getDb()
    .prepare('SELECT * FROM orchestration_step_attempts WHERE attempt_id=?')
    .get(input.attemptId) as AttemptRow;
  return rowToAttempt(attempt);
}

export function getReadyStepAttempts(runId: string): StepAttempt[] {
  const run = getOrchestrationRun(runId);
  if (!run || (run.status !== 'queued' && run.status !== 'running') || run.cancel_requested_at) return [];
  const attempts = getStepAttempts(runId);
  const latest = new Map<string, StepAttempt>();
  for (const attempt of attempts) {
    const current = latest.get(attempt.step_id);
    if (!current || attempt.attempt > current.attempt) latest.set(attempt.step_id, attempt);
  }
  return run.plan.steps
    .filter((step) => {
      const attempt = latest.get(step.id);
      return (
        attempt?.status === 'queued' &&
        step.dependsOn.every((dependency) => latest.get(dependency)?.status === 'succeeded')
      );
    })
    .map((step) => latest.get(step.id)!);
}

export function leaseReadyStep(input: { runId: string; stepId: string; owner: string; now?: string }): StepAttempt {
  const now = input.now ?? new Date().toISOString();
  const db = getDb();
  let attemptId = '';
  db.transaction(() => {
    const run = getOrchestrationRun(input.runId);
    if (!run) throw new Error(`Orchestration run not found: ${input.runId}`);
    const step = run.plan.steps.find((candidate) => candidate.id === input.stepId);
    if (!step) throw new Error(`Orchestration step not found: ${input.stepId}`);
    if (!getReadyStepAttempts(input.runId).some((attempt) => attempt.step_id === input.stepId)) {
      throw new Error(`Orchestration step is not dependency-ready: ${input.stepId}`);
    }
    const attempt = getStepAttempts(input.runId)
      .filter((candidate) => candidate.step_id === input.stepId)
      .sort((a, b) => b.attempt - a.attempt)[0];
    attemptId = attempt.attempt_id;
    const leaseExpiresAt = addMs(now, step.timeoutMs);
    const result = db
      .prepare(
        `UPDATE orchestration_step_attempts
         SET status='running', started_at=COALESCE(started_at, ?),
             lease_owner=?, lease_expires_at=?
         WHERE attempt_id=? AND status='queued'`,
      )
      .run(now, input.owner, leaseExpiresAt, attempt.attempt_id);
    if (result.changes !== 1) throw new Error(`Orchestration step lease race: ${input.stepId}`);
    const runUpdate = db
      .prepare(
        `UPDATE orchestration_runs SET status='running',
         started_at=COALESCE(started_at, ?), updated_at=?
         WHERE run_id=? AND status IN ('queued','running')`,
      )
      .run(now, now, input.runId);
    if (runUpdate.changes !== 1) throw new Error(`Orchestration run lease race: ${input.runId}`);
    appendEvent({
      eventId: `${attempt.attempt_id}:leased`,
      runId: input.runId,
      eventType: 'step_leased',
      stepId: input.stepId,
      attempt: attempt.attempt,
      data: { owner: input.owner, leaseExpiresAt },
      createdAt: now,
    });
  })();
  return getStepAttempts(input.runId).find((candidate) => candidate.attempt_id === attemptId)!;
}

/** Return a clean, undispatched lease to the queue after startup failure. */
export function releaseStepLease(input: {
  attemptId: string;
  owner: string;
  reason: string;
  now?: string;
}): StepAttempt {
  const now = input.now ?? new Date().toISOString();
  const db = getDb();
  let runId = '';
  db.transaction(() => {
    const attempt = db.prepare('SELECT * FROM orchestration_step_attempts WHERE attempt_id=?').get(input.attemptId) as
      AttemptRow | undefined;
    if (!attempt) throw new Error(`Orchestration attempt not found: ${input.attemptId}`);
    runId = attempt.run_id;
    const result = db
      .prepare(
        `UPDATE orchestration_step_attempts
         SET status='queued', started_at=NULL, lease_owner=NULL, lease_expires_at=NULL
         WHERE attempt_id=? AND status='running' AND lease_owner=?
           AND side_effect_boundary_crossed IS NULL
           AND result_emitted=0 AND artifact_emitted=0 AND delivery_emitted=0`,
      )
      .run(input.attemptId, input.owner);
    if (result.changes !== 1) throw new Error(`Orchestration lease is not safely releasable: ${input.attemptId}`);
    appendEvent({
      eventId: `${input.attemptId}:lease-released:${now}`,
      runId: attempt.run_id,
      eventType: 'step_lease_released',
      stepId: attempt.step_id,
      attempt: attempt.attempt,
      data: { owner: input.owner, reason: input.reason.slice(0, 512) },
      createdAt: now,
    });
    recomputeRun(attempt.run_id, now);
  })();
  return getStepAttempts(runId).find((attempt) => attempt.attempt_id === input.attemptId)!;
}

export function createOrchestrationRun(plan: ExecutionPlan, inputMessageId: string): OrchestrationRun {
  validateExecutionPlan(plan);
  const existing = getOrchestrationRunByPlan(plan.planId);
  if (existing) {
    if (
      existing.task_id !== plan.taskId ||
      existing.agent_group_id !== plan.metadata.agentGroupId ||
      existing.session_id !== plan.metadata.sessionId ||
      JSON.stringify(existing.plan) !== JSON.stringify(plan)
    ) {
      throw new Error(`Orchestration plan identity conflict: ${plan.planId}`);
    }
    return existing;
  }
  const db = getDb();
  const runId = `run:${plan.taskId}`;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO orchestration_runs
       (run_id, plan_id, task_id, agent_group_id, session_id, pattern_id,
        pattern_version, status, plan_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    ).run(
      runId,
      plan.planId,
      plan.taskId,
      plan.metadata.agentGroupId,
      plan.metadata.sessionId,
      plan.pattern.id,
      plan.pattern.version,
      JSON.stringify(plan),
      plan.metadata.createdAt,
      plan.metadata.createdAt,
    );
    const insertAttempt = db.prepare(
      `INSERT INTO orchestration_step_attempts
       (attempt_id, run_id, step_id, role_id, kind, attempt, status,
        idempotency_key, input_message_id, queued_at, execution_session_id)
       VALUES (?, ?, ?, ?, ?, 1, 'queued', ?, ?, ?, ?)`,
    );
    for (const step of plan.steps) {
      insertAttempt.run(
        `${runId}:${step.id}:1`,
        runId,
        step.id,
        step.roleId ?? null,
        step.kind,
        `${runId}:${step.id}:1`,
        step.kind === 'model' ? inputMessageId : null,
        plan.metadata.createdAt,
        step.kind === 'model' ? plan.metadata.sessionId : null,
      );
    }
    appendEvent({
      eventId: `${runId}:created`,
      runId,
      eventType: 'run_created',
      data: { planId: plan.planId, pattern: plan.pattern },
      createdAt: plan.metadata.createdAt,
    });
  })();
  return getOrchestrationRun(runId)!;
}

export function markRunDispatched(runId: string): void {
  const now = new Date().toISOString();
  getDb().transaction(() => {
    const run = getOrchestrationRun(runId);
    if (!run) throw new Error(`Orchestration run not found: ${runId}`);
    leaseReadyStep({ runId, stepId: 'model', owner: `session:${run.session_id}`, now });
    appendEvent({
      eventId: `${runId}:dispatched`,
      runId,
      eventType: 'model_dispatched',
      stepId: 'model',
      attempt: 1,
      createdAt: now,
    });
  })();
}

function recomputeRun(runId: string, now: string): void {
  const run = getOrchestrationRun(runId);
  const attempts = getStepAttempts(runId);
  const latest = new Map<string, StepAttempt>();
  for (const attempt of attempts) {
    const current = latest.get(attempt.step_id);
    if (!current || attempt.attempt > current.attempt) latest.set(attempt.step_id, attempt);
  }
  const currentAttempts = [...latest.values()];
  const status: OrchestrationStatus = run?.cancel_requested_at
    ? 'cancelled'
    : currentAttempts.some((attempt) => attempt.status === 'failed')
      ? 'failed'
      : currentAttempts.every((attempt) => attempt.status === 'succeeded')
        ? 'succeeded'
        : currentAttempts.some((attempt) => attempt.status === 'cancelled')
          ? 'cancelled'
          : 'running';
  getDb()
    .prepare(
      `UPDATE orchestration_runs SET status=?, updated_at=?,
       finished_at=CASE WHEN ? IN ('succeeded','failed','cancelled') THEN COALESCE(finished_at, ?) ELSE NULL END
       WHERE run_id=?`,
    )
    .run(status, now, status, now, runId);
}

function aggregateUsage(existing: ModelUsage | undefined, next: ModelUsage): ModelUsage {
  const sum = (left: number | undefined, right: number | undefined): number | undefined =>
    left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
  return {
    inputTokens: sum(existing?.inputTokens, next.inputTokens),
    outputTokens: sum(existing?.outputTokens, next.outputTokens),
    cachedTokens: sum(existing?.cachedTokens, next.cachedTokens),
    estimatedCostUsd: sum(existing?.estimatedCostUsd, next.estimatedCostUsd),
    source: !existing || existing.source === next.source ? next.source : 'unknown',
  };
}

export function recordModelBatchResult(input: {
  eventId: string;
  sourceSessionId: string;
  inputMessageIds: string[];
  outcome: 'result' | 'terminal-error' | 'silent-close' | 'interrupted' | 'exception';
  usage?: ModelUsage;
  error?: {
    classification: string;
    retryable: boolean;
    sideEffectBoundaryCrossed: boolean | null;
  };
  createdAt?: string;
}): StepAttempt[] {
  const now = input.createdAt ?? new Date().toISOString();
  const db = getDb();
  const attempts = input.inputMessageIds
    .map(
      (id) =>
        db
          .prepare(
            `SELECT a.* FROM orchestration_step_attempts a
             JOIN orchestration_runs r ON r.run_id=a.run_id
             WHERE a.input_message_id=? AND a.kind='model'
               AND COALESCE(a.execution_session_id, r.session_id)=?
             ORDER BY a.attempt DESC`,
          )
          .get(id, input.sourceSessionId) as AttemptRow | undefined,
    )
    .filter((row): row is AttemptRow => Boolean(row && (row.status === 'queued' || row.status === 'running')));
  const usageOwner = [...attempts].sort((a, b) => a.run_id.localeCompare(b.run_id))[0]?.run_id;
  const completedAttemptIds: string[] = [];
  db.transaction(() => {
    for (const attempt of attempts) {
      const succeeded = input.outcome === 'result';
      const usage = attempt.run_id === usageOwner ? input.usage : undefined;
      const updated = db
        .prepare(
          `UPDATE orchestration_step_attempts SET status=?, usage_json=?,
         error_class=?, error_message=?, error_retryable=?, finished_at=?,
          side_effect_boundary_crossed=?, result_emitted=?,
          lease_owner=NULL, lease_expires_at=NULL, batch_id=?
         WHERE attempt_id=? AND status IN ('queued','running')`,
        )
        .run(
          succeeded ? 'succeeded' : 'failed',
          usage ? JSON.stringify(usage) : null,
          succeeded ? null : (input.error?.classification ?? input.outcome),
          succeeded ? null : `Runner ended with ${input.outcome}`,
          succeeded ? null : input.error?.retryable === true ? 1 : input.error?.retryable === false ? 0 : null,
          now,
          succeeded
            ? 1
            : input.error?.sideEffectBoundaryCrossed === true
              ? 1
              : input.error?.sideEffectBoundaryCrossed === false
                ? 0
                : null,
          succeeded ? 1 : 0,
          input.eventId,
          attempt.attempt_id,
        );
      if (updated.changes !== 1) continue;
      completedAttemptIds.push(attempt.attempt_id);
      if (usage) {
        const existing = getOrchestrationRun(attempt.run_id)?.usage;
        db.prepare('UPDATE orchestration_runs SET usage_json=? WHERE run_id=?').run(
          JSON.stringify(aggregateUsage(existing, usage)),
          attempt.run_id,
        );
      }
      appendEvent({
        eventId: `${input.eventId}:${attempt.run_id}`,
        runId: attempt.run_id,
        eventType: succeeded ? 'model_succeeded' : 'model_failed',
        stepId: attempt.step_id,
        attempt: attempt.attempt,
        data: {
          outcome: input.outcome,
          usageOwnerRunId: usageOwner,
          sharedBatchSize: attempts.length,
        },
        createdAt: now,
      });
      recomputeRun(attempt.run_id, now);
    }
  })();
  const completed = new Set(completedAttemptIds);
  return attempts
    .filter((attempt) => completed.has(attempt.attempt_id))
    .map((attempt) => {
      const current = getStepAttempts(attempt.run_id).find((item) => item.attempt_id === attempt.attempt_id);
      if (!current) throw new Error(`Completed orchestration attempt disappeared: ${attempt.attempt_id}`);
      return current;
    });
}

export function recordDirectDelivery(input: {
  sourceSessionId: string;
  inputMessageId: string;
  outboundMessageId: string;
  status: 'succeeded' | 'failed';
  createdAt?: string;
}): void {
  const now = input.createdAt ?? new Date().toISOString();
  const db = getDb();
  const modelAttempt = db
    .prepare(
      `SELECT a.* FROM orchestration_step_attempts a
       JOIN orchestration_runs r ON r.run_id=a.run_id
       WHERE a.input_message_id=? AND a.kind='model'
         AND COALESCE(a.execution_session_id, r.session_id)=?
       ORDER BY a.attempt DESC`,
    )
    .get(input.inputMessageId, input.sourceSessionId) as AttemptRow | undefined;
  if (!modelAttempt) return;
  const modelAttempts = modelAttempt.batch_id
    ? (db
        .prepare(
          `SELECT a.* FROM orchestration_step_attempts a
           JOIN orchestration_runs r ON r.run_id=a.run_id
           WHERE a.kind='model' AND a.batch_id=?
             AND COALESCE(a.execution_session_id, r.session_id)=?`,
        )
        .all(modelAttempt.batch_id, input.sourceSessionId) as AttemptRow[])
    : [modelAttempt];
  db.transaction(() => {
    for (const owner of modelAttempts) {
      db.prepare(
        `UPDATE orchestration_step_attempts
         SET delivery_emitted=1, side_effect_boundary_crossed=1
         WHERE attempt_id=?`,
      ).run(owner.attempt_id);
      const updated = db
        .prepare(
          `UPDATE orchestration_step_attempts SET status=?, started_at=COALESCE(started_at, ?),
           finished_at=?, error_class=?, error_message=?
           WHERE run_id=? AND kind='delivery' AND status IN ('queued','running')`,
        )
        .run(
          input.status,
          now,
          now,
          input.status === 'failed' ? 'delivery_failed' : null,
          input.status === 'failed' ? 'Outbound delivery failed' : null,
          owner.run_id,
        );
      if (updated.changes !== 1) continue;
      appendEvent({
        eventId: `delivery:${input.outboundMessageId}:${owner.run_id}`,
        runId: owner.run_id,
        eventType: input.status === 'succeeded' ? 'delivery_succeeded' : 'delivery_failed',
        stepId: 'delivery',
        attempt: 1,
        data: { outboundMessageId: input.outboundMessageId, batchId: modelAttempt.batch_id },
        createdAt: now,
      });
      recomputeRun(owner.run_id, now);
      const sourceSession = db.prepare('SELECT session_id FROM orchestration_runs WHERE run_id=?').get(owner.run_id) as
        { session_id: string } | undefined;
      if (owner.execution_session_id && owner.execution_session_id !== sourceSession?.session_id) {
        db.prepare("UPDATE sessions SET status='closed' WHERE id=?").run(owner.execution_session_id);
      }
    }
  })();
}

export type DirectDeliveryDecision = { state: 'legacy' } | { state: 'wait' | 'allow' | 'suppress'; runId: string };

export function directDeliveryDecision(sourceSessionId: string, inputMessageId: string): DirectDeliveryDecision {
  const row = getDb()
    .prepare(
      `SELECT a.status AS model_status, r.run_id, r.status AS run_status,
              COALESCE(a.execution_session_id, r.session_id) AS execution_session_id
       FROM orchestration_step_attempts a
       JOIN orchestration_runs r ON r.run_id=a.run_id
       WHERE a.input_message_id=? AND a.kind='model'
         AND (
           COALESCE(a.execution_session_id, r.session_id)=?
           OR r.session_id=?
         )
       ORDER BY a.attempt DESC LIMIT 1`,
    )
    .get(inputMessageId, sourceSessionId, sourceSessionId) as
    | {
        model_status: StepStatus;
        run_id: string;
        run_status: OrchestrationStatus;
        execution_session_id: string;
      }
    | undefined;
  if (!row) return { state: 'legacy' };
  if (row.execution_session_id !== sourceSessionId) {
    return { state: 'suppress', runId: row.run_id };
  }
  if (row.run_status === 'cancelled' || row.model_status === 'cancelled') {
    return { state: 'suppress', runId: row.run_id };
  }
  if (row.model_status === 'queued' || row.model_status === 'running') {
    return { state: 'wait', runId: row.run_id };
  }
  return { state: 'allow', runId: row.run_id };
}

export function getCorrelatedOrchestrationRunId(sourceSessionId: string, inputMessageId: string): string | undefined {
  return (
    getDb()
      .prepare(
        `SELECT r.run_id FROM orchestration_step_attempts a
         JOIN orchestration_runs r ON r.run_id=a.run_id
         WHERE a.input_message_id=? AND a.kind='model'
           AND COALESCE(a.execution_session_id, r.session_id)=?
         ORDER BY a.attempt DESC LIMIT 1`,
      )
      .get(inputMessageId, sourceSessionId) as { run_id: string } | undefined
  )?.run_id;
}

export function authorizeCorrelatedHostAction(input: {
  sourceSessionId: string;
  inputMessageId: string;
  outboundMessageId: string;
  action: string;
  createdAt?: string;
}): { correlated: boolean; runId?: string } {
  const now = input.createdAt ?? new Date().toISOString();
  authorizeSessionHostAction(input.sourceSessionId, input.action);
  const row = getDb()
    .prepare(
      `SELECT r.run_id, r.status AS run_status, a.status AS attempt_status
       FROM orchestration_step_attempts a
       JOIN orchestration_runs r ON r.run_id=a.run_id
       WHERE a.input_message_id=? AND a.kind='model'
         AND COALESCE(a.execution_session_id, r.session_id)=?
       ORDER BY a.attempt DESC LIMIT 1`,
    )
    .get(input.inputMessageId, input.sourceSessionId) as
    { run_id: string; run_status: OrchestrationStatus; attempt_status: StepStatus } | undefined;
  if (!row) return { correlated: false };
  if (row.run_status !== 'running' || row.attempt_status !== 'running') {
    throw new Error(`Orchestration host action rejected for inactive run: ${row.run_id}`);
  }
  getDb()
    .prepare(
      `UPDATE orchestration_step_attempts
       SET side_effect_boundary_crossed=1
       WHERE run_id=? AND kind='model' AND status='running'`,
    )
    .run(row.run_id);
  appendEvent({
    eventId: `host-action:${input.outboundMessageId}:${row.run_id}`,
    runId: row.run_id,
    eventType: 'host_action_authorized',
    stepId: 'model',
    attempt: 1,
    data: { action: input.action },
    createdAt: now,
  });
  return { correlated: true, runId: row.run_id };
}

export function authorizeSessionHostAction(sourceSessionId: string, action: string): void {
  const entrypoint = `host:${action.replaceAll('_', '-')}`;
  const capability = listCapabilities().find((manifest) =>
    manifest.adapters.some((adapter) => adapter.kind === 'host-action' && adapter.entrypoint === entrypoint),
  );
  if (!capability) {
    throw new Error(`Host action has no capability manifest: ${action}`);
  }
  const snapshot = getDb()
    .prepare('SELECT capabilities_json FROM orchestration_session_authorizations WHERE session_id=?')
    .get(sourceSessionId) as { capabilities_json: string } | undefined;
  const granted = snapshot ? (JSON.parse(snapshot.capabilities_json) as string[]) : [];
  if (!granted.includes(capability.id)) {
    throw new Error(`Host action requires compiled capability: ${capability.id}`);
  }
}

export function requestOrchestrationCancellation(input: {
  runId: string;
  agentGroupId?: string;
  reason?: string;
  createdAt?: string;
}): OrchestrationRun {
  const now = input.createdAt ?? new Date().toISOString();
  const run = getOrchestrationRun(input.runId);
  if (!run) throw new Error(`Orchestration run not found: ${input.runId}`);
  if (input.agentGroupId && run.agent_group_id !== input.agentGroupId) {
    throw new Error('Cannot cancel another agent group orchestration run');
  }
  const latestModelAttempt = getStepAttempts(run.run_id)
    .filter((attempt) => attempt.kind === 'model')
    .sort((left, right) => right.attempt - left.attempt)[0];
  const modelStep = latestModelAttempt
    ? run.plan.steps.find((step) => step.id === latestModelAttempt.step_id)
    : undefined;
  const fallbackPending =
    run.status === 'failed' &&
    latestModelAttempt?.status === 'failed' &&
    modelStep?.onFailure === 'fallback' &&
    latestModelAttempt.attempt < modelStep.retry.maxAttempts;
  if (['succeeded', 'cancelled'].includes(run.status) || (run.status === 'failed' && !fallbackPending)) return run;
  const reason = (input.reason?.trim() || 'cancelled by operator').slice(0, 4096);
  getDb().transaction(() => {
    getDb()
      .prepare(
        `UPDATE orchestration_runs
         SET cancel_requested_at=COALESCE(cancel_requested_at, ?),
             cancel_reason=COALESCE(cancel_reason, ?), updated_at=?
         WHERE run_id=?`,
      )
      .run(now, reason, now, input.runId);
    getDb()
      .prepare(
        `UPDATE orchestration_step_attempts
         SET status='cancelled', error_class='cancelled', error_message=?,
             finished_at=COALESCE(finished_at, ?),
             lease_owner=NULL, lease_expires_at=NULL
         WHERE run_id=? AND status IN ('queued','running','needs_input')`,
      )
      .run(reason, now, input.runId);
    recomputeRun(input.runId, now);
    appendEvent({
      eventId: `${input.runId}:cancelled`,
      runId: input.runId,
      eventType: 'run_cancelled',
      data: { reason },
      createdAt: now,
    });
  })();
  return getOrchestrationRun(input.runId)!;
}

export function recoverOrchestrationRuns(now = new Date().toISOString()): {
  expiredLeases: number;
  expiredRuns: number;
} {
  const db = getDb();
  let expiredLeases = 0;
  let expiredRuns = 0;
  const leased = db
    .prepare(
      `SELECT a.*, r.plan_json FROM orchestration_step_attempts a
       JOIN orchestration_runs r ON r.run_id=a.run_id
       WHERE a.status='running' AND a.lease_expires_at IS NOT NULL
         AND a.lease_expires_at <= ? AND r.status='running'`,
    )
    .all(now) as Array<AttemptRow & { plan_json: string }>;
  for (const attempt of leased) {
    db.transaction(() => {
      const result = db
        .prepare(
          `UPDATE orchestration_step_attempts
           SET status='failed', error_class='lease_expired',
               error_message='Execution lease expired', finished_at=?,
               lease_owner=NULL, lease_expires_at=NULL
           WHERE attempt_id=? AND status='running'`,
        )
        .run(now, attempt.attempt_id);
      if (result.changes === 0) return;
      expiredLeases++;
      appendEvent({
        eventId: `${attempt.attempt_id}:lease-expired`,
        runId: attempt.run_id,
        eventType: 'step_lease_expired',
        stepId: attempt.step_id,
        attempt: attempt.attempt,
        createdAt: now,
      });
      recomputeRun(attempt.run_id, now);
    })();
  }

  const active = db.prepare("SELECT * FROM orchestration_runs WHERE status IN ('queued','running')").all() as RunRow[];
  for (const row of active) {
    const run = rowToRun(row);
    const deadline = Date.parse(run.created_at) + run.plan.budgets.wallClockTimeoutMs;
    if (!Number.isFinite(deadline) || deadline > Date.parse(now)) continue;
    db.transaction(() => {
      const result = db
        .prepare(
          `UPDATE orchestration_step_attempts
           SET status='failed', error_class='plan_timeout',
               error_message='Execution plan wall-clock budget expired',
               finished_at=?, lease_owner=NULL, lease_expires_at=NULL
           WHERE run_id=? AND status IN ('queued','running','needs_input')`,
        )
        .run(now, run.run_id);
      if (result.changes === 0) return;
      expiredRuns++;
      appendEvent({
        eventId: `${run.run_id}:plan-timeout`,
        runId: run.run_id,
        eventType: 'plan_timed_out',
        createdAt: now,
      });
      recomputeRun(run.run_id, now);
    })();
  }
  return { expiredLeases, expiredRuns };
}

export function failRunDispatch(runId: string, error: unknown): void {
  const now = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  getDb().transaction(() => {
    getDb()
      .prepare(
        `UPDATE orchestration_step_attempts SET status='failed', error_class='dispatch',
         error_message=?, finished_at=? WHERE run_id=? AND kind='model' AND status='queued'`,
      )
      .run(message.slice(0, 4096), now, runId);
    recomputeRun(runId, now);
    appendEvent({
      eventId: `${runId}:dispatch-failed:${randomUUID()}`,
      runId,
      eventType: 'dispatch_failed',
      stepId: 'model',
      attempt: 1,
      data: { message: message.slice(0, 4096) },
      createdAt: now,
    });
  })();
}
