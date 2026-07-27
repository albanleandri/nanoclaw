import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setAuxiliaryRoute } from '../db/auxiliary-routes.js';
import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from '../db/index.js';
import { executeAuxiliaryInvocation } from './service.js';

const runtime = {
  runtimeId: 'claude-sdk',
  runtimeStateKey: 'claude',
};

function group(id: string): void {
  createAgentGroup({
    id,
    name: id,
    folder: id,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  group('source');
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
    setAuxiliaryRoute('source', 'review', { kind: 'main' });
    const result = await executeAuxiliaryInvocation({
      invocation: {
        invocationId: 'aux',
        role: 'review',
        objective: 'Review',
        context: 'private',
        timeoutMs: 5_000,
      },
      session: { id: 'session', agent_group_id: 'source' },
      currentRuntime: runtime,
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

  it('stamps the invocation source from the trusted session', async () => {
    setAuxiliaryRoute('source', 'review', { kind: 'main' });
    let seen: { agentGroupId: string; sessionId: string } | undefined;
    await executeAuxiliaryInvocation({
      invocation: { invocationId: 'stamped', role: 'review', objective: 'Review', context: '', timeoutMs: 5_000 },
      session: { id: 'session', agent_group_id: 'source' },
      currentRuntime: runtime,
      executor: async (request) => {
        seen = { agentGroupId: request.sourceAgentGroupId, sessionId: request.sourceSessionId };
        return { status: 'succeeded' };
      },
    });
    expect(seen).toEqual({ agentGroupId: 'source', sessionId: 'session' });
  });

  it('resolves the route of the session group, not a route configured for another group', async () => {
    group('other');
    // Only 'other' has a review route. A caller running in 'source' must not
    // reach it — the route is looked up from the trusted session's group.
    setAuxiliaryRoute('other', 'review', { kind: 'main' });
    await expect(
      executeAuxiliaryInvocation({
        invocation: { invocationId: 'foreign', role: 'review', objective: 'Review', context: '', timeoutMs: 5_000 },
        session: { id: 'session', agent_group_id: 'source' },
        currentRuntime: runtime,
        executor: async () => ({ status: 'succeeded' }),
      }),
    ).rejects.toThrow(/disabled/);
  });

  it('fails closed when the role is explicitly disabled', async () => {
    setAuxiliaryRoute('source', 'review', { kind: 'disabled' });
    await expect(
      executeAuxiliaryInvocation({
        invocation: { invocationId: 'disabled', role: 'review', objective: 'Review', context: '', timeoutMs: 5_000 },
        session: { id: 'session', agent_group_id: 'source' },
        currentRuntime: runtime,
        executor: async () => ({ status: 'succeeded' }),
      }),
    ).rejects.toThrow(/disabled/);
  });

  it('fails closed when the role has no configured route at all', async () => {
    await expect(
      executeAuxiliaryInvocation({
        invocation: { invocationId: 'unrouted', role: 'vision', objective: 'Look', context: '', timeoutMs: 5_000 },
        session: { id: 'session', agent_group_id: 'source' },
        currentRuntime: runtime,
        executor: async () => ({ status: 'succeeded' }),
      }),
    ).rejects.toThrow(/disabled/);
  });
});
