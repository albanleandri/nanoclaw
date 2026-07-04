import Database from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from '../db/index.js';
import { handleSystemAction, registerDeliveryAction } from '../delivery.js';
import type { Session } from '../types.js';
import { compileDirectPlan } from './patterns/direct.js';
import {
  createOrchestrationRun,
  markRunDispatched,
  recordSessionCapabilityAuthorization,
  requestOrchestrationCancellation,
} from './run-store.js';
import { registerCapability } from '../capabilities/capability-registry.js';

const handler = vi.fn(async () => {});
const session: Session = {
  id: 'session',
  agent_group_id: 'agent',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-01-01',
};

beforeAll(() => {
  registerDeliveryAction('orchestration_auth_test', handler);
  registerDeliveryAction('orchestration_unmapped_test', handler);
  registerCapability({
    id: 'test.orchestration-auth',
    version: 1,
    description: 'Test-only correlated host action.',
    requirements: {},
    sideEffects: 'local-write',
    approval: 'never',
    adapters: [{ kind: 'host-action', entrypoint: 'host:orchestration-auth-test' }],
  });
});
beforeEach(() => {
  handler.mockClear();
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'agent', name: 'Agent', folder: 'agent', agent_provider: null, created_at: '2026-01-01' });
  createSession(session);
});
afterEach(closeDb);

function activeRun() {
  const plan = compileDirectPlan({
    taskId: 'task',
    objective: 'hello',
    kind: 'chat',
    agentGroupId: 'agent',
    sessionId: 'session',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const run = createOrchestrationRun(plan, 'input');
  markRunDispatched(run.run_id);
  recordSessionCapabilityAuthorization('session', ['test.orchestration-auth']);
  return run;
}

describe('run-correlated host action authorization', () => {
  it('executes a correlated action only during its active model attempt', async () => {
    activeRun();
    const inDb = new Database(':memory:');
    await handleSystemAction({ action: 'orchestration_auth_test' }, session, inDb, {
      inReplyTo: 'input',
      outboundMessageId: 'action:1',
    });
    expect(handler).toHaveBeenCalledOnce();
    inDb.close();
  });

  it('rejects a correlated action that has no capability manifest', async () => {
    activeRun();
    const inDb = new Database(':memory:');
    await expect(
      handleSystemAction({ action: 'orchestration_unmapped_test' }, session, inDb, {
        inReplyTo: 'input',
        outboundMessageId: 'action:unmapped',
      }),
    ).rejects.toThrow(/no capability manifest/i);
    expect(handler).not.toHaveBeenCalled();
    inDb.close();
  });

  it('rejects a queued action after cancellation before invoking its handler', async () => {
    const run = activeRun();
    requestOrchestrationCancellation({ runId: run.run_id });
    const inDb = new Database(':memory:');
    await expect(
      handleSystemAction({ action: 'orchestration_auth_test' }, session, inDb, {
        inReplyTo: 'input',
        outboundMessageId: 'action:late',
      }),
    ).rejects.toThrow(/inactive run/);
    expect(handler).not.toHaveBeenCalled();
    inDb.close();
  });
});
