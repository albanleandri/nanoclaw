import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from '../db/index.js';
import { compileDirectPlan } from '../orchestration/patterns/direct.js';
import { createOrchestrationRun } from '../orchestration/run-store.js';
import { listCapabilityAuditEvents } from './capability-events.js';
import { handleCapabilityAudit } from './host-bridge.js';

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
  createAgentGroup({ id: 'agent', name: 'agent', folder: 'agent', agent_provider: null, created_at: '2026-01-01' });
  createSession(session);
});
afterEach(closeDb);

describe('capability audit host bridge', () => {
  it('derives actor identity from the source session', async () => {
    const run = createOrchestrationRun(
      compileDirectPlan({
        taskId: 'task',
        objective: 'search',
        kind: 'chat',
        agentGroupId: 'agent',
        sessionId: 'session',
        createdAt: '2026-01-01',
      }),
      'input',
    );
    const inDb = new Database(':memory:');
    await handleCapabilityAudit(
      {
        eventId: 'event',
        invocationId: 'invocation',
        seq: 1,
        eventType: 'requested',
        capabilityId: 'memory.session-search',
        capabilityVersion: 1,
        adapter: 'mcp',
        entrypoint: 'tool:session_search',
        argsSha256: 'b'.repeat(64),
        agentGroupId: 'spoofed',
        createdAt: '2026-01-01',
      },
      session,
      inDb,
      { inReplyTo: 'input', outboundMessageId: 'audit-event' },
    );
    expect(listCapabilityAuditEvents({ agentGroupId: 'agent' })).toEqual([
      expect.objectContaining({ orchestration_run_id: run.run_id }),
    ]);
    expect(listCapabilityAuditEvents({ agentGroupId: 'spoofed' })).toHaveLength(0);
    inDb.close();
  });

  it('rejects an entrypoint that is not declared by the capability', async () => {
    const inDb = new Database(':memory:');
    await expect(
      handleCapabilityAudit(
        {
          eventId: 'event',
          invocationId: 'invocation',
          seq: 1,
          eventType: 'requested',
          capabilityId: 'memory.session-search',
          capabilityVersion: 1,
          adapter: 'mcp',
          entrypoint: 'tool:send_message',
          argsSha256: 'b'.repeat(64),
        },
        session,
        inDb,
      ),
    ).rejects.toThrow(/entrypoint mismatch/);
    inDb.close();
  });
});
