import type { ModelUsage } from '../auxiliary/types.js';
import { getDb } from '../db/connection.js';

export type CapabilityAuditEventType =
  | 'requested'
  | 'authorized'
  | 'denied'
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface CapabilityAuditEvent {
  eventId: string;
  invocationId: string;
  seq: number;
  eventType: CapabilityAuditEventType;
  agentGroupId: string;
  sessionId: string;
  runtimeId?: string;
  capabilityId: string;
  capabilityVersion: number;
  adapter: string;
  entrypoint: string;
  argsSha256: string;
  decision?: string;
  resultClass?: string;
  durationMs?: number;
  usage?: ModelUsage;
  orchestrationRunId?: string;
  createdAt: string;
}

const TRANSITIONS: Record<CapabilityAuditEventType, ReadonlySet<CapabilityAuditEventType>> = {
  requested: new Set(['authorized', 'denied', 'started', 'cancelled']),
  authorized: new Set(['started', 'denied', 'cancelled']),
  denied: new Set(),
  started: new Set(['succeeded', 'failed', 'cancelled']),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function appendCapabilityAuditEvent(event: CapabilityAuditEvent): void {
  if (!event.eventId.trim() || !event.invocationId.trim()) throw new Error('Capability audit identity is required');
  if (!/^[a-f0-9]{64}$/.test(event.argsSha256)) throw new Error('Invalid capability audit argument hash');
  if (!Number.isInteger(event.seq) || event.seq < 1) throw new Error('Invalid capability audit sequence');
  if (event.durationMs !== undefined && (!Number.isInteger(event.durationMs) || event.durationMs < 0)) {
    throw new Error('Invalid capability audit duration');
  }
  // Scope the idempotency lookup to the owning agent group: event_id is
  // derived from the container-controlled invocation_id, and uniqueness is now
  // keyed per tenant (migration 031), so a global lookup would let one group's
  // event_id block or shadow another group's append.
  const existing = getDb()
    .prepare('SELECT * FROM capability_audit_events WHERE agent_group_id = ? AND event_id = ?')
    .get(event.agentGroupId, event.eventId) as Record<string, unknown> | undefined;
  if (existing) {
    if (
      existing.invocation_id !== event.invocationId ||
      existing.seq !== event.seq ||
      existing.event_type !== event.eventType ||
      existing.args_sha256 !== event.argsSha256 ||
      existing.orchestration_run_id !== (event.orchestrationRunId ?? null)
    ) {
      throw new Error(`Capability audit event conflict: ${event.eventId}`);
    }
    return;
  }
  // Scope the chain lookup to the owning agent group. invocation_id is chosen
  // by the caller while agent_group_id is stamped from the trusted session, so
  // an unscoped lookup would let one group's events chain onto (or block)
  // another group's invocation timeline. Uniqueness is likewise keyed on
  // (agent_group_id, invocation_id, seq) — see migration 031.
  const previous = getDb()
    .prepare(
      `SELECT seq, event_type FROM capability_audit_events
       WHERE agent_group_id = ? AND invocation_id = ? ORDER BY seq DESC LIMIT 1`,
    )
    .get(event.agentGroupId, event.invocationId) as { seq: number; event_type: CapabilityAuditEventType } | undefined;
  if (!previous && (event.seq !== 1 || event.eventType !== 'requested')) {
    throw new Error('Capability audit invocation must begin with requested sequence 1');
  }
  if (previous && (event.seq !== previous.seq + 1 || !TRANSITIONS[previous.event_type].has(event.eventType))) {
    throw new Error(`Invalid capability audit transition: ${previous.event_type} -> ${event.eventType}`);
  }
  try {
    getDb()
      .prepare(
        `INSERT INTO capability_audit_events
       (event_id, invocation_id, seq, event_type, agent_group_id, session_id,
        runtime_id, capability_id, capability_version, adapter, entrypoint,
        args_sha256, decision, result_class, duration_ms, usage_json,
        orchestration_run_id, created_at)
       VALUES (@eventId, @invocationId, @seq, @eventType, @agentGroupId, @sessionId,
        @runtimeId, @capabilityId, @capabilityVersion, @adapter, @entrypoint,
        @argsSha256, @decision, @resultClass, @durationMs, @usageJson,
        @orchestrationRunId, @createdAt)`,
      )
      .run({
        ...event,
        runtimeId: event.runtimeId ?? null,
        decision: event.decision ?? null,
        resultClass: event.resultClass ?? null,
        durationMs: event.durationMs ?? null,
        usageJson: event.usage ? JSON.stringify(event.usage) : null,
        orchestrationRunId: event.orchestrationRunId ?? null,
      });
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      throw new Error(`Capability audit sequence conflict: ${event.invocationId}:${event.seq}`, { cause: error });
    }
    throw error;
  }
}

export function listCapabilityAuditEvents(input: {
  agentGroupId: string;
  sessionId?: string;
  capabilityId?: string;
  decision?: string;
  resultClass?: string;
  after?: string;
  before?: string;
  limit?: number;
}): Array<Record<string, unknown>> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  return getDb()
    .prepare(
      `SELECT event_id, invocation_id, seq, event_type, agent_group_id, session_id,
              runtime_id, capability_id, capability_version, adapter, entrypoint,
              args_sha256, decision, result_class, duration_ms, usage_json,
              orchestration_run_id, created_at
       FROM capability_audit_events
       WHERE agent_group_id=@agentGroupId
         AND (@sessionId IS NULL OR session_id=@sessionId)
         AND (@capabilityId IS NULL OR capability_id=@capabilityId)
         AND (@decision IS NULL OR decision=@decision)
         AND (@resultClass IS NULL OR result_class=@resultClass)
         AND (@after IS NULL OR created_at>=@after)
         AND (@before IS NULL OR created_at<=@before)
       ORDER BY created_at DESC, invocation_id DESC, seq DESC
       LIMIT @limit`,
    )
    .all({
      agentGroupId: input.agentGroupId,
      sessionId: input.sessionId ?? null,
      capabilityId: input.capabilityId ?? null,
      decision: input.decision ?? null,
      resultClass: input.resultClass ?? null,
      after: input.after ?? null,
      before: input.before ?? null,
      limit,
    }) as Array<Record<string, unknown>>;
}
