import { getDb } from './connection.js';

export type AgentMemoryMode = 'disabled' | 'shadow' | 'active';
export type AgentMemoryMigrationState = 'none' | 'staging' | 'validated' | 'migrated';

export interface AgentGroupMemoryControl {
  agent_group_id: string;
  mode: AgentMemoryMode;
  migration_state: AgentMemoryMigrationState;
  writer_session_id: string | null;
  maintenance_fence_owner: string | null;
  maintenance_fence_token: string | null;
  maintenance_fenced_at: string | null;
  version: number;
  last_transition_at: string;
  updated_at: string;
}

export interface MemoryControlTransition {
  mode: AgentMemoryMode;
  migrationState: AgentMemoryMigrationState;
  writerSessionId: string | null;
}

const LEGAL_STATES = new Set(['disabled:none', 'shadow:staging', 'shadow:validated', 'active:migrated']);
const FORWARD_TRANSITIONS = new Set([
  'disabled:none->shadow:staging',
  'shadow:staging->shadow:validated',
  'shadow:validated->active:migrated',
]);

function assertLegalState(input: MemoryControlTransition): void {
  if (!LEGAL_STATES.has(`${input.mode}:${input.migrationState}`)) {
    throw new Error(`Invalid memory control state: ${input.mode}/${input.migrationState}`);
  }
  if (input.mode === 'active' && !input.writerSessionId) {
    throw new Error('Active memory requires a writer session');
  }
}

export function ensureAgentGroupMemoryControl(agentGroupId: string, now = new Date().toISOString()): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO agent_group_memory_control (
        agent_group_id, mode, migration_state, writer_session_id, version, last_transition_at, updated_at
      ) VALUES (?, 'disabled', 'none', NULL, 1, ?, ?)`,
    )
    .run(agentGroupId, now, now);
}

export function getAgentGroupMemoryControl(agentGroupId: string): AgentGroupMemoryControl | undefined {
  return getDb().prepare('SELECT * FROM agent_group_memory_control WHERE agent_group_id = ?').get(agentGroupId) as
    AgentGroupMemoryControl | undefined;
}

export function isAgentGroupMemoryMaintenanceHeld(agentGroupId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1
       FROM agent_group_memory_control
       WHERE agent_group_id = ?
         AND maintenance_fence_token IS NOT NULL`,
    )
    .get(agentGroupId);
  return row !== undefined;
}

export function acquireAgentGroupMemoryFence(
  agentGroupId: string,
  owner: string,
  token: string,
  now = new Date().toISOString(),
): boolean {
  if (!owner || !token) throw new Error('Memory maintenance fence owner and token are required');
  ensureAgentGroupMemoryControl(agentGroupId, now);
  const result = getDb()
    .prepare(
      `UPDATE agent_group_memory_control
       SET maintenance_fence_owner = ?,
           maintenance_fence_token = ?,
           maintenance_fenced_at = ?,
           updated_at = ?
       WHERE agent_group_id = ?
         AND maintenance_fence_token IS NULL`,
    )
    .run(owner, token, now, now, agentGroupId);
  return result.changes === 1;
}

export function releaseAgentGroupMemoryFence(
  agentGroupId: string,
  token: string,
  now = new Date().toISOString(),
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE agent_group_memory_control
       SET maintenance_fence_owner = NULL,
           maintenance_fence_token = NULL,
           maintenance_fenced_at = NULL,
           updated_at = ?
       WHERE agent_group_id = ?
         AND maintenance_fence_token = ?`,
    )
    .run(now, agentGroupId, token);
  return result.changes === 1;
}

export function transitionAgentGroupMemoryControl(
  agentGroupId: string,
  expectedVersion: number,
  input: MemoryControlTransition,
  now = new Date().toISOString(),
): AgentGroupMemoryControl {
  assertLegalState(input);
  const current = getAgentGroupMemoryControl(agentGroupId);
  if (!current || current.version !== expectedVersion) {
    throw new Error(`Memory control transition conflict for agent group: ${agentGroupId}`);
  }
  const transition = `${current.mode}:${current.migration_state}->${input.mode}:${input.migrationState}`;
  if (!FORWARD_TRANSITIONS.has(transition)) {
    throw new Error(`Invalid memory control transition: ${transition}`);
  }
  const result = getDb()
    .prepare(
      `UPDATE agent_group_memory_control
       SET mode = ?,
           migration_state = ?,
           writer_session_id = ?,
           version = version + 1,
           last_transition_at = ?,
           updated_at = ?
       WHERE agent_group_id = ?
         AND version = ?`,
    )
    .run(input.mode, input.migrationState, input.writerSessionId, now, now, agentGroupId, expectedVersion);
  if (result.changes !== 1) {
    throw new Error(`Memory control transition conflict for agent group: ${agentGroupId}`);
  }
  return getAgentGroupMemoryControl(agentGroupId)!;
}

/**
 * Restore a migration's recorded control-plane state. This deliberately is not
 * a general backwards transition: possession of the workflow fence token and
 * an exact current version are both required.
 */
export function restoreAgentGroupMemoryControl(
  agentGroupId: string,
  expectedVersion: number,
  fenceToken: string,
  input: MemoryControlTransition,
  now = new Date().toISOString(),
): AgentGroupMemoryControl {
  assertLegalState(input);
  if (!fenceToken) throw new Error('Memory rollback requires the workflow fence token');
  const result = getDb()
    .prepare(
      `UPDATE agent_group_memory_control
       SET mode = ?,
           migration_state = ?,
           writer_session_id = ?,
           version = version + 1,
           last_transition_at = ?,
           updated_at = ?
       WHERE agent_group_id = ?
         AND version = ?
         AND maintenance_fence_token = ?`,
    )
    .run(input.mode, input.migrationState, input.writerSessionId, now, now, agentGroupId, expectedVersion, fenceToken);
  if (result.changes !== 1) {
    throw new Error(`Memory control rollback conflict for agent group: ${agentGroupId}`);
  }
  return getAgentGroupMemoryControl(agentGroupId)!;
}

export function transferAgentGroupMemoryWriter(
  agentGroupId: string,
  expectedVersion: number,
  expectedWriterSessionId: string | null,
  writerSessionId: string,
  now = new Date().toISOString(),
): AgentGroupMemoryControl {
  if (!writerSessionId) throw new Error('A new writer session is required');
  const current = getAgentGroupMemoryControl(agentGroupId);
  if (!current || current.version !== expectedVersion) {
    throw new Error(`Memory writer transfer conflict for agent group: ${agentGroupId}`);
  }
  if (current.mode === 'disabled') {
    throw new Error('Cannot transfer the writer while neutral memory is disabled');
  }
  if (current.writer_session_id !== expectedWriterSessionId) {
    throw new Error(`Memory writer changed for agent group: ${agentGroupId}`);
  }
  const session = getDb().prepare('SELECT agent_group_id FROM sessions WHERE id = ?').get(writerSessionId) as
    { agent_group_id: string } | undefined;
  if (!session || session.agent_group_id !== agentGroupId) {
    throw new Error(`Writer session does not belong to agent group: ${writerSessionId}`);
  }
  const result = getDb()
    .prepare(
      `UPDATE agent_group_memory_control
       SET writer_session_id = ?,
           version = version + 1,
           last_transition_at = ?,
           updated_at = ?
       WHERE agent_group_id = ?
         AND version = ?
         AND writer_session_id IS ?`,
    )
    .run(writerSessionId, now, now, agentGroupId, expectedVersion, expectedWriterSessionId);
  if (result.changes !== 1) {
    throw new Error(`Memory writer transfer conflict for agent group: ${agentGroupId}`);
  }
  return getAgentGroupMemoryControl(agentGroupId)!;
}
