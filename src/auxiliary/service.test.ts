import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from '../db/index.js';
import { executeAuxiliaryInvocation } from './service.js';

const runtime = {
  runtimeId: 'claude-sdk',
  runtimeStateKey: 'claude',
};

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: 'source',
    name: 'source',
    folder: 'source',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  createSession({
    id: 'session',
    agent_group_id: 'source',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  });
});
afterEach(closeDb);

describe('auxiliary service', () => {
  it('compiles a tool-free main plan and persists private output', async () => {
    const result = await executeAuxiliaryInvocation({
      request: {
        invocationId: 'aux',
        role: 'review',
        objective: 'Review',
        context: 'private',
        sourceAgentGroupId: 'source',
        sourceSessionId: 'session',
        timeoutMs: 5_000,
      },
      currentRuntime: runtime,
      target: { kind: 'main' },
      executor: async (_request, resolution) => {
        expect(resolution.plan.capabilities).toEqual([]);
        expect(resolution.plan.policy).toMatchObject({ cliScope: 'disabled', writableWorkspace: false });
        return {
          status: 'succeeded',
          output: 'private result',
          usage: { inputTokens: 2, outputTokens: 1, source: 'provider' },
        };
      },
    });
    expect(result).toMatchObject({ status: 'succeeded', output: 'private result', runtimeId: 'claude-sdk' });
  });

  it('fails closed when the role is disabled', async () => {
    await expect(
      executeAuxiliaryInvocation({
        request: {
          invocationId: 'disabled',
          role: 'review',
          objective: 'Review',
          context: '',
          sourceAgentGroupId: 'source',
          sourceSessionId: 'session',
          timeoutMs: 5_000,
        },
        currentRuntime: runtime,
        target: { kind: 'disabled' },
        executor: async () => ({ status: 'succeeded' }),
      }),
    ).rejects.toThrow(/disabled/);
  });
});
