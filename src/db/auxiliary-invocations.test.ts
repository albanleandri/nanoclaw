import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AuxiliaryRequest } from '../auxiliary/types.js';
import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from './index.js';
import {
  completeAuxiliaryInvocation,
  createAuxiliaryInvocation,
  getAuxiliaryInvocation,
} from './auxiliary-invocations.js';

const request: AuxiliaryRequest = {
  invocationId: 'aux-1',
  role: 'review',
  objective: 'Review result',
  context: 'bounded context',
  sourceAgentGroupId: 'source',
  sourceSessionId: 'session',
  timeoutMs: 5_000,
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

describe('auxiliary invocations', () => {
  it('creates idempotently and stores a normalized terminal result', () => {
    expect(createAuxiliaryInvocation(request, { kind: 'main' })).toEqual(
      createAuxiliaryInvocation(request, { kind: 'main' }),
    );
    completeAuxiliaryInvocation({
      invocationId: 'aux-1',
      status: 'succeeded',
      output: 'ok',
      runtimeId: 'claude-sdk',
      usage: { inputTokens: 4, outputTokens: 2, source: 'provider' },
    });
    const stored = getAuxiliaryInvocation('aux-1')!;
    expect(stored.job.status).toBe('succeeded');
    expect(stored.job.result?.output).toBe('ok');
    expect(stored.usage?.inputTokens).toBe(4);
  });

  it('rejects conflicting invocation reuse', () => {
    createAuxiliaryInvocation(request, { kind: 'main' });
    expect(() => createAuxiliaryInvocation({ ...request, objective: 'different' }, { kind: 'main' })).toThrow(
      /conflict/,
    );
  });
});
