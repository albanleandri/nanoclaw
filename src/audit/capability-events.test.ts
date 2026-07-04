import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from '../db/index.js';
import { appendCapabilityAuditEvent, listCapabilityAuditEvents } from './capability-events.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'agent', name: 'agent', folder: 'agent', agent_provider: null, created_at: '2026-01-01' });
  createSession({
    id: 'session',
    agent_group_id: 'agent',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-01-01',
  });
});
afterEach(closeDb);

describe('capability audit store', () => {
  it('appends idempotent redacted events scoped by agent', () => {
    const event = {
      eventId: 'event-1',
      invocationId: 'invocation',
      seq: 1,
      eventType: 'requested' as const,
      agentGroupId: 'agent',
      sessionId: 'session',
      capabilityId: 'memory.session-search',
      capabilityVersion: 1,
      adapter: 'mcp',
      entrypoint: 'tool:session_search',
      argsSha256: 'a'.repeat(64),
      createdAt: '2026-01-01',
    };
    appendCapabilityAuditEvent(event);
    appendCapabilityAuditEvent(event);
    expect(listCapabilityAuditEvents({ agentGroupId: 'agent' })).toEqual([
      expect.objectContaining({
        event_id: 'event-1',
        args_sha256: 'a'.repeat(64),
        capability_id: 'memory.session-search',
      }),
    ]);
  });

  it('isolates invocation chains per agent group (same invocation_id/seq across tenants)', () => {
    createAgentGroup({
      id: 'agent2',
      name: 'agent2',
      folder: 'agent2',
      agent_provider: null,
      created_at: '2026-01-01',
    });
    createSession({
      id: 'session2',
      agent_group_id: 'agent2',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-01-01',
    });

    const base = {
      invocationId: 'shared-inv',
      capabilityId: 'memory.session-search',
      capabilityVersion: 1,
      adapter: 'mcp',
      entrypoint: 'tool:session_search',
      argsSha256: 'a'.repeat(64),
      createdAt: '2026-01-01',
    };

    // Group 1 opens a chain on invocation shared-inv.
    appendCapabilityAuditEvent({
      ...base,
      eventId: 'g1-req',
      seq: 1,
      eventType: 'requested',
      agentGroupId: 'agent',
      sessionId: 'session',
    });
    // Group 2 reuses the SAME invocation_id + seq. Under the old global
    // UNIQUE(invocation_id, seq) this collided (blocking group 2) and the
    // unscoped chain lookup saw group 1's event; now each tenant is isolated.
    appendCapabilityAuditEvent({
      ...base,
      eventId: 'g2-req',
      seq: 1,
      eventType: 'requested',
      agentGroupId: 'agent2',
      sessionId: 'session2',
    });
    // Group 1 continues its own chain, unaffected by group 2.
    appendCapabilityAuditEvent({
      ...base,
      eventId: 'g1-started',
      seq: 2,
      eventType: 'started',
      agentGroupId: 'agent',
      sessionId: 'session',
    });

    expect(
      listCapabilityAuditEvents({ agentGroupId: 'agent' })
        .map((e) => e.event_id)
        .sort(),
    ).toEqual(['g1-req', 'g1-started']);
    expect(listCapabilityAuditEvents({ agentGroupId: 'agent2' }).map((e) => e.event_id)).toEqual(['g2-req']);
  });

  it('rejects malformed hashes and event identity conflicts', () => {
    expect(() =>
      appendCapabilityAuditEvent({
        eventId: 'bad',
        invocationId: 'i',
        seq: 1,
        eventType: 'failed',
        agentGroupId: 'agent',
        sessionId: 'session',
        capabilityId: 'memory.session-search',
        capabilityVersion: 1,
        adapter: 'mcp',
        entrypoint: 'tool:session_search',
        argsSha256: 'raw arguments',
        createdAt: '2026-01-01',
      }),
    ).toThrow(/hash/);
  });

  it('enforces ordered lifecycle transitions and stable retry payloads', () => {
    const base = {
      invocationId: 'invocation',
      agentGroupId: 'agent',
      sessionId: 'session',
      capabilityId: 'memory.session-search',
      capabilityVersion: 1,
      adapter: 'mcp',
      entrypoint: 'tool:session_search',
      argsSha256: 'a'.repeat(64),
      createdAt: '2026-01-01',
    };
    expect(() =>
      appendCapabilityAuditEvent({
        ...base,
        eventId: 'started-first',
        seq: 1,
        eventType: 'started',
      }),
    ).toThrow(/begin with requested/);
    appendCapabilityAuditEvent({ ...base, eventId: 'requested', seq: 1, eventType: 'requested' });
    appendCapabilityAuditEvent({ ...base, eventId: 'started', seq: 2, eventType: 'started' });
    appendCapabilityAuditEvent({
      ...base,
      eventId: 'complete',
      seq: 3,
      eventType: 'succeeded',
      durationMs: 2,
    });
    expect(() =>
      appendCapabilityAuditEvent({
        ...base,
        eventId: 'after-complete',
        seq: 4,
        eventType: 'failed',
      }),
    ).toThrow(/transition/);
    expect(() =>
      appendCapabilityAuditEvent({
        ...base,
        eventId: 'requested',
        seq: 1,
        eventType: 'requested',
        argsSha256: 'b'.repeat(64),
      }),
    ).toThrow(/conflict/);
  });
});
