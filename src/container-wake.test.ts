import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireAgentGroupMemoryFence, closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { tryReserveContainerSlot, wakeContainerWithResult } from './container-runner.js';
import type { Session } from './types.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(closeDb);

describe('wakeContainerWithResult', () => {
  it('returns a typed startup failure instead of reporting success for a missing group', async () => {
    const session: Session = {
      id: 'orphan-session',
      agent_group_id: 'missing-agent-group',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-01-01',
    };

    await expect(wakeContainerWithResult(session)).resolves.toEqual({
      status: 'failed',
      error: 'Agent group not found: missing-agent-group',
    });
  });

  it('returns maintenance-held before reserving or spawning', async () => {
    createAgentGroup({
      id: 'held-agent',
      name: 'Held Agent',
      folder: 'held-agent',
      agent_provider: null,
      created_at: '2026-01-01',
    });
    acquireAgentGroupMemoryFence('held-agent', 'test', 'fence-token', '2026-01-01');
    const session: Session = {
      id: 'held-session',
      agent_group_id: 'held-agent',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-01-01',
    };

    await expect(wakeContainerWithResult(session)).resolves.toEqual({ status: 'maintenance-held' });
  });
});

describe('container admission reservations', () => {
  it('atomically reserves distinct sessions up to the configured limit', () => {
    const reservations = new Set<string>();

    expect(tryReserveContainerSlot('session-b', ['session-a'], reservations, 2)).toBe(true);
    expect(tryReserveContainerSlot('session-c', ['session-a'], reservations, 2)).toBe(false);
    expect(reservations).toEqual(new Set(['session-b']));
  });

  it('counts the union of active and reserved sessions without double-counting a started reservation', () => {
    const reservations = new Set(['session-a']);

    expect(tryReserveContainerSlot('session-b', ['session-a'], reservations, 2)).toBe(true);
    expect(reservations).toEqual(new Set(['session-a', 'session-b']));
  });
});
