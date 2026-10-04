import { randomUUID } from 'node:crypto';

import { requireHostIntegrationOperation, type HostIntegrationRegistry } from '../integrations/registry.js';
import type { IntegrationInvocationCallerType, IntegrationInvocationRow } from '../types.js';
import { getDb } from './connection.js';
import { getIntegrationProfileRow } from './integration-profiles.js';

type RegistryReader = Pick<HostIntegrationRegistry, 'requireOperation'>;

const defaultRegistry: RegistryReader = { requireOperation: requireHostIntegrationOperation };

export type IntegrationInvocationFailureClass =
  | 'not_authorized'
  | 'disabled'
  | 'credential_unavailable'
  | 'credential_unsafe'
  | 'authentication_rejected'
  | 'upstream_timeout'
  | 'upstream_transient'
  | 'upstream_contract_changed'
  | 'invalid_configuration'
  | 'busy'
  | 'internal';

const FAILURE_CLASSES = new Set<IntegrationInvocationFailureClass>([
  'not_authorized',
  'disabled',
  'credential_unavailable',
  'credential_unsafe',
  'authentication_rejected',
  'upstream_timeout',
  'upstream_transient',
  'upstream_contract_changed',
  'invalid_configuration',
  'busy',
  'internal',
]);

export interface StartIntegrationInvocationInput {
  id?: string;
  profileId: string;
  operation: string;
  callerType: IntegrationInvocationCallerType;
  agentGroupId?: string | null;
  sessionId?: string | null;
  startedAt?: string;
}

export interface FinishIntegrationInvocationInput {
  status: 'succeeded' | 'failed';
  resultClass: 'success' | IntegrationInvocationFailureClass;
  finishedAt?: string;
}

export function startIntegrationInvocation(
  input: StartIntegrationInvocationInput,
  registry: RegistryReader = defaultRegistry,
): IntegrationInvocationRow {
  const profile = getIntegrationProfileRow(input.profileId);
  if (!profile) throw new Error('Integration profile not found');
  registry.requireOperation(profile.adapter_id, profile.adapter_version, input.operation);
  validateCaller(input.callerType, input.agentGroupId ?? null, input.sessionId ?? null);
  const id = input.id ?? `integration-invocation-${randomUUID()}`;
  const startedAt = input.startedAt ?? new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO integration_invocations (
        id, profile_id, profile_name, adapter_id, adapter_version, operation,
        caller_type, agent_group_id, session_id, status, result_class,
        duration_ms, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)`,
    )
    .run(
      id,
      profile.id,
      profile.name,
      profile.adapter_id,
      profile.adapter_version,
      input.operation,
      input.callerType,
      input.agentGroupId ?? null,
      input.sessionId ?? null,
      startedAt,
    );
  return getIntegrationInvocation(id)!;
}

export function finishIntegrationInvocation(
  id: string,
  input: FinishIntegrationInvocationInput,
): IntegrationInvocationRow {
  if (
    (input.status === 'succeeded' && input.resultClass !== 'success') ||
    (input.status === 'failed' && !FAILURE_CLASSES.has(input.resultClass as IntegrationInvocationFailureClass))
  ) {
    throw new Error('Integration invocation result class does not match status');
  }
  const finishedAt = input.finishedAt ?? new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE integration_invocations
       SET status = ?, result_class = ?,
           duration_ms = MAX(0, CAST(ROUND((julianday(?) - julianday(started_at)) * 86400000) AS INTEGER)),
           finished_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(input.status, input.resultClass, finishedAt, finishedAt, id);
  if (result.changes !== 1) throw new Error('Integration invocation completion conflict');
  return getIntegrationInvocation(id)!;
}

export function getIntegrationInvocation(id: string): IntegrationInvocationRow | undefined {
  return getDb().prepare('SELECT * FROM integration_invocations WHERE id = ?').get(id) as
    IntegrationInvocationRow | undefined;
}

export function listIntegrationInvocations(profileId?: string, limit = 100): IntegrationInvocationRow[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('Integration invocation list limit is invalid');
  }
  if (profileId) {
    return getDb()
      .prepare(
        `SELECT * FROM integration_invocations
         WHERE profile_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(profileId, limit) as IntegrationInvocationRow[];
  }
  return getDb()
    .prepare('SELECT * FROM integration_invocations ORDER BY started_at DESC, id DESC LIMIT ?')
    .all(limit) as IntegrationInvocationRow[];
}

/** Close rows that cannot still have an in-memory owner after host restart. */
export function reconcileInterruptedIntegrationInvocations(finishedAt = new Date().toISOString()): number {
  return getDb()
    .prepare(
      `UPDATE integration_invocations
       SET status = 'interrupted', result_class = 'interrupted_on_restart',
           duration_ms = MAX(0, CAST(ROUND((julianday(?) - julianday(started_at)) * 86400000) AS INTEGER)),
           finished_at = ?
       WHERE status = 'running'`,
    )
    .run(finishedAt, finishedAt).changes;
}

function validateCaller(
  callerType: IntegrationInvocationCallerType,
  agentGroupId: string | null,
  sessionId: string | null,
): void {
  if (callerType === 'host') {
    if (agentGroupId !== null || sessionId !== null) {
      throw new Error('Host integration invocation cannot carry agent identity');
    }
    return;
  }
  if (callerType !== 'agent' || !agentGroupId) throw new Error('Agent integration invocation requires an agent group');
  if (!getDb().prepare('SELECT 1 FROM agent_groups WHERE id = ?').get(agentGroupId)) {
    throw new Error('Agent group not found');
  }
  if (sessionId) {
    const session = getDb().prepare('SELECT agent_group_id FROM sessions WHERE id = ?').get(sessionId) as
      { agent_group_id: string } | undefined;
    if (!session || session.agent_group_id !== agentGroupId) {
      throw new Error('Integration invocation session does not belong to agent group');
    }
  }
}
