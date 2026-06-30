import type { AuxiliaryRequest, AuxiliaryResult, AuxiliaryTarget, ModelUsage } from '../auxiliary/types.js';
import { createJob, getJob, type JobRecord } from './jobs.js';
import { getDb } from './connection.js';

export interface AuxiliaryInvocationRecord {
  job: JobRecord<AuxiliaryRequest, AuxiliaryResult>;
  target: AuxiliaryTarget;
  runtimeId?: string;
  isolatedSessionId?: string;
  usage?: ModelUsage;
}

function read(id: string): AuxiliaryInvocationRecord | undefined {
  const job = getJob(id) as JobRecord<AuxiliaryRequest, AuxiliaryResult> | undefined;
  if (!job || job.type !== 'auxiliary_invocation') return undefined;
  const row = getDb().prepare('SELECT * FROM auxiliary_invocations WHERE job_id = ?').get(id) as
    | {
        target_kind: AuxiliaryTarget['kind'];
        provider_profile_id: string | null;
        target_agent_group_id: string | null;
        target_model: string | null;
        runtime_id: string | null;
        isolated_session_id: string | null;
        usage_json: string | null;
      }
    | undefined;
  if (!row) return undefined;
  const target: AuxiliaryTarget =
    row.target_kind === 'endpoint-profile'
      ? {
          kind: row.target_kind,
          providerProfileId: row.provider_profile_id!,
          model: row.target_model ?? undefined,
        }
      : row.target_kind === 'agent'
        ? { kind: row.target_kind, agentGroupId: row.target_agent_group_id! }
        : { kind: row.target_kind };
  return {
    job,
    target,
    runtimeId: row.runtime_id ?? undefined,
    isolatedSessionId: row.isolated_session_id ?? undefined,
    usage: row.usage_json ? (JSON.parse(row.usage_json) as ModelUsage) : undefined,
  };
}

export function createAuxiliaryInvocation(
  request: AuxiliaryRequest,
  target: AuxiliaryTarget,
): AuxiliaryInvocationRecord {
  const existing = read(request.invocationId);
  if (existing) {
    if (
      JSON.stringify(existing.job.params) !== JSON.stringify(request) ||
      JSON.stringify(existing.target) !== JSON.stringify(target)
    ) {
      throw new Error(`Auxiliary invocation conflict: ${request.invocationId}`);
    }
    return existing;
  }
  const db = getDb();
  db.transaction(() => {
    createJob({
      id: request.invocationId,
      type: 'auxiliary_invocation',
      agentGroupId: request.sourceAgentGroupId,
      sessionId: request.sourceSessionId,
      params: request,
    });
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO auxiliary_invocations
       (job_id, role, target_kind, provider_profile_id, target_agent_group_id, target_model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      request.invocationId,
      request.role,
      target.kind,
      target.kind === 'endpoint-profile' ? target.providerProfileId : null,
      target.kind === 'agent' ? target.agentGroupId : null,
      target.kind === 'endpoint-profile' ? (target.model ?? null) : null,
      now,
      now,
    );
  })();
  return read(request.invocationId)!;
}

export function completeAuxiliaryInvocation(result: AuxiliaryResult): AuxiliaryInvocationRecord {
  const existing = read(result.invocationId);
  if (!existing) throw new Error(`Auxiliary invocation not found: ${result.invocationId}`);
  if (existing.job.status !== 'queued' && existing.job.status !== 'running') return existing;
  const status = result.status === 'succeeded' ? 'succeeded' : result.status === 'cancelled' ? 'cancelled' : 'failed';
  const now = new Date().toISOString();
  getDb().transaction(() => {
    const claimed = getDb()
      .prepare(
        `UPDATE jobs SET status=?, result_json=?, error=?, finished_at=?, updated_at=?
         WHERE id=? AND status IN ('queued', 'running')`,
      )
      .run(status, JSON.stringify(result), result.error?.message ?? null, now, now, result.invocationId);
    if (claimed.changes === 0) return;
    getDb()
      .prepare(
        `UPDATE auxiliary_invocations
         SET runtime_id = ?, usage_json = ?, updated_at = ? WHERE job_id = ?`,
      )
      .run(result.runtimeId ?? null, result.usage ? JSON.stringify(result.usage) : null, now, result.invocationId);
  })();
  return read(result.invocationId)!;
}

export const getAuxiliaryInvocation = read;
