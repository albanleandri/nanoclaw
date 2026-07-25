import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireAgentGroupMemoryFence,
  closeDb,
  createAgentGroup,
  createSession,
  getAgentGroupMemoryControl,
  initTestDb,
  isAgentGroupMemoryMaintenanceHeld,
  releaseAgentGroupMemoryFence,
  restoreAgentGroupMemoryControl,
  runMigrations,
  transferAgentGroupMemoryWriter,
  transitionAgentGroupMemoryControl,
} from './index.js';
import type { Session } from '../types.js';

const createdAt = '2026-07-25T10:00:00.000Z';

function session(id: string, agentGroupId: string): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: createdAt,
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: 'agent-a',
    name: 'Agent A',
    folder: 'agent-a',
    agent_provider: null,
    created_at: createdAt,
  });
  createAgentGroup({
    id: 'agent-b',
    name: 'Agent B',
    folder: 'agent-b',
    agent_provider: null,
    created_at: createdAt,
  });
  createSession(session('session-a', 'agent-a'));
  createSession(session('session-a2', 'agent-a'));
  createSession(session('session-b', 'agent-b'));
});

afterEach(closeDb);

describe('agent group memory control', () => {
  it('creates new groups disabled with no migration or writer', () => {
    expect(getAgentGroupMemoryControl('agent-a')).toMatchObject({
      mode: 'disabled',
      migration_state: 'none',
      writer_session_id: null,
      version: 1,
    });
  });

  it('acquires and releases a durable fence by token', () => {
    expect(acquireAgentGroupMemoryFence('agent-a', 'migration-cli', 'token-1', createdAt)).toBe(true);
    expect(acquireAgentGroupMemoryFence('agent-a', 'other', 'token-2', createdAt)).toBe(false);
    expect(isAgentGroupMemoryMaintenanceHeld('agent-a')).toBe(true);
    expect(releaseAgentGroupMemoryFence('agent-a', 'wrong-token', createdAt)).toBe(false);
    expect(releaseAgentGroupMemoryFence('agent-a', 'token-1', createdAt)).toBe(true);
    expect(isAgentGroupMemoryMaintenanceHeld('agent-a')).toBe(false);
  });

  it('enforces the forward rollout state machine', () => {
    const staging = transitionAgentGroupMemoryControl('agent-a', 1, {
      mode: 'shadow',
      migrationState: 'staging',
      writerSessionId: 'session-a',
    });
    const validated = transitionAgentGroupMemoryControl('agent-a', staging.version, {
      mode: 'shadow',
      migrationState: 'validated',
      writerSessionId: 'session-a',
    });
    const active = transitionAgentGroupMemoryControl('agent-a', validated.version, {
      mode: 'active',
      migrationState: 'migrated',
      writerSessionId: 'session-a',
    });

    expect(active).toMatchObject({
      mode: 'active',
      migration_state: 'migrated',
      writer_session_id: 'session-a',
      version: 4,
    });
  });

  it('rejects skipped states and stale versions', () => {
    expect(() =>
      transitionAgentGroupMemoryControl('agent-a', 1, {
        mode: 'active',
        migrationState: 'migrated',
        writerSessionId: 'session-a',
      }),
    ).toThrow('Invalid memory control transition');

    expect(() =>
      transitionAgentGroupMemoryControl('agent-a', 99, {
        mode: 'shadow',
        migrationState: 'staging',
        writerSessionId: 'session-a',
      }),
    ).toThrow('transition conflict');
  });

  it('rejects a writer session owned by another group', () => {
    expect(() =>
      transitionAgentGroupMemoryControl('agent-a', 1, {
        mode: 'shadow',
        migrationState: 'staging',
        writerSessionId: 'session-b',
      }),
    ).toThrow('memory writer session must belong to agent group');
  });

  it('transfers writer ownership with version and current-writer compare-and-swap checks', () => {
    const staging = transitionAgentGroupMemoryControl('agent-a', 1, {
      mode: 'shadow',
      migrationState: 'staging',
      writerSessionId: 'session-a',
    });
    const transferred = transferAgentGroupMemoryWriter(
      'agent-a',
      staging.version,
      'session-a',
      'session-a2',
      createdAt,
    );

    expect(transferred).toMatchObject({
      mode: 'shadow',
      migration_state: 'staging',
      writer_session_id: 'session-a2',
      version: 3,
    });
    expect(() =>
      transferAgentGroupMemoryWriter('agent-a', staging.version, 'session-a', 'session-a2', createdAt),
    ).toThrow('transfer conflict');
  });

  it('rejects disabled, cross-group, and unexpected-current-writer transfers', () => {
    expect(() => transferAgentGroupMemoryWriter('agent-a', 1, null, 'session-a2', createdAt)).toThrow('disabled');
    const staging = transitionAgentGroupMemoryControl('agent-a', 1, {
      mode: 'shadow',
      migrationState: 'staging',
      writerSessionId: 'session-a',
    });
    expect(() =>
      transferAgentGroupMemoryWriter('agent-a', staging.version, 'session-a2', 'session-a', createdAt),
    ).toThrow('writer changed');
    expect(() =>
      transferAgentGroupMemoryWriter('agent-a', staging.version, 'session-a', 'session-b', createdAt),
    ).toThrow('does not belong');
  });

  it('permits only fence-token-guarded rollback to a recorded legal state', () => {
    expect(acquireAgentGroupMemoryFence('agent-a', 'migration', 'rollback-token', createdAt)).toBe(true);
    const staging = transitionAgentGroupMemoryControl('agent-a', 1, {
      mode: 'shadow',
      migrationState: 'staging',
      writerSessionId: null,
    });
    expect(() =>
      restoreAgentGroupMemoryControl('agent-a', staging.version, 'wrong-token', {
        mode: 'disabled',
        migrationState: 'none',
        writerSessionId: null,
      }),
    ).toThrow('rollback conflict');

    expect(
      restoreAgentGroupMemoryControl('agent-a', staging.version, 'rollback-token', {
        mode: 'disabled',
        migrationState: 'none',
        writerSessionId: null,
      }),
    ).toMatchObject({ mode: 'disabled', migration_state: 'none', writer_session_id: null });
  });
});
