import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  drainContainerWakes: vi.fn(),
  killContainer: vi.fn(),
  isContainerRunning: vi.fn().mockReturnValue(false),
  isContainerWakeInFlight: vi.fn().mockReturnValue(false),
}));

import { closeDb, createAgentGroup, getAgentGroupMemoryControl, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { lookup } from '../registry.js';
import './memory.js';

const groupId = 'ag-memory-operator';
const sessionId = 'session-memory-operator';

describe('memory operator CLI', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    const now = new Date().toISOString();
    createAgentGroup({
      id: groupId,
      name: 'Memory Operator',
      folder: 'memory-operator',
      agent_provider: 'claude',
      created_at: now,
    });
    createSession({
      id: sessionId,
      agent_group_id: groupId,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: 'claude',
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now,
    });
  });

  afterEach(() => closeDb());

  it('reports rollout, fence, writer, and effective session access without bodies', async () => {
    const command = lookup('memory-status')!;
    const result = (await command.handler(command.parseArgs({ 'agent-group-id': groupId }), {
      caller: 'host',
    })) as Record<string, unknown>;

    expect(result).toMatchObject({
      agent_group_id: groupId,
      mode: 'disabled',
      migration_state: 'none',
      writer_session_id: null,
      sessions: [expect.objectContaining({ id: sessionId, memory_access: 'none' })],
    });
    expect(JSON.stringify(result)).not.toContain('content');
  });

  it('acquires and token-guards an explicit durable fence', async () => {
    const fence = lookup('memory-fence')!;
    const fenced = (await fence.handler(fence.parseArgs({ 'agent-group-id': groupId, owner: 'test-workflow' }), {
      caller: 'host',
    })) as { token: string };
    expect(getAgentGroupMemoryControl(groupId)).toMatchObject({
      maintenance_fence_owner: 'test-workflow',
      maintenance_fence_token: fenced.token,
    });

    const unfence = lookup('memory-unfence')!;
    await expect(
      unfence.handler(unfence.parseArgs({ 'agent-group-id': groupId, token: 'wrong-token' }), { caller: 'host' }),
    ).rejects.toThrow('did not match');
    await unfence.handler(unfence.parseArgs({ 'agent-group-id': groupId, token: fenced.token }), { caller: 'host' });
    expect(getAgentGroupMemoryControl(groupId)?.maintenance_fence_token).toBeNull();
  });

  it('keeps mutation commands approval-gated', () => {
    expect(lookup('memory-fence')?.access).toBe('approval');
    expect(lookup('memory-unfence')?.access).toBe('approval');
    expect(lookup('memory-validate')?.access).toBe('open');
    for (const operation of ['prepare', 'classify', 'validate', 'approve', 'finish', 'smoke', 'rollback']) {
      expect(lookup(`memory-migrate-${operation}`)?.access).toBe('approval');
    }
    expect(lookup('memory-migrate-status')?.access).toBe('open');
  });
});
