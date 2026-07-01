import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from '../db/index.js';
import { handleOrchestrationResult } from './host-bridge.js';
import { compileDirectPlan } from './patterns/direct.js';
import { createOrchestrationRun, getOrchestrationRun, markRunDispatched } from './run-store.js';

const session = {
  id: 'session',
  agent_group_id: 'agent',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active' as const,
  container_status: 'stopped' as const,
  last_active: null,
  created_at: '2026-01-01',
};

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'agent', name: 'Agent', folder: 'agent', agent_provider: null, created_at: '2026-01-01' });
  createSession(session);
  const plan = compileDirectPlan({
    taskId: 'task',
    objective: 'hello',
    kind: 'chat',
    agentGroupId: 'agent',
    sessionId: 'session',
  });
  const run = createOrchestrationRun(plan, 'adapter/id with spaces');
  markRunDispatched(run.run_id);
});
afterEach(closeDb);

describe('orchestration result host bridge', () => {
  it('persists a runner result with source-derived session identity', async () => {
    const inDb = new Database(':memory:');
    await handleOrchestrationResult(
      {
        eventId: 'orchestration-result:event',
        inputMessageIds: ['adapter/id with spaces'],
        outcome: 'result',
        usage: { inputTokens: 4, outputTokens: 1, source: 'provider' },
      },
      session,
      inDb,
    );
    expect(getOrchestrationRun('run:task')).toMatchObject({
      status: 'running',
      usage: { inputTokens: 4, outputTokens: 1, source: 'provider' },
    });
    inDb.close();
  });

  it('rejects malformed event IDs and usage', async () => {
    const inDb = new Database(':memory:');
    await expect(
      handleOrchestrationResult(
        {
          eventId: 'bad',
          inputMessageIds: ['adapter/id with spaces'],
          outcome: 'result',
        },
        session,
        inDb,
      ),
    ).rejects.toThrow(/event ID/);
    await expect(
      handleOrchestrationResult(
        {
          eventId: 'orchestration-result:event',
          inputMessageIds: ['adapter/id with spaces'],
          outcome: 'result',
          usage: { inputTokens: -1, source: 'provider' },
        },
        session,
        inDb,
      ),
    ).rejects.toThrow(/inputTokens/);
    inDb.close();
  });
});
