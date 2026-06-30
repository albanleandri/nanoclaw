import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from '../db/index.js';
import { countSessionSearchDocuments, searchSessions, upsertSessionSearchDocument } from './store.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  for (const group of ['a', 'b']) {
    createAgentGroup({
      id: group,
      name: group,
      folder: group,
      agent_provider: null,
      created_at: '2026-01-01T00:00:00Z',
    });
    createSession({
      id: `session-${group}`,
      agent_group_id: group,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-01-01T00:00:00Z',
    });
  }
});
afterEach(closeDb);

describe('session search store', () => {
  it('searches only the requested agent and returns source attribution', () => {
    for (const group of ['a', 'b']) {
      upsertSessionSearchDocument({
        agentGroupId: group,
        sessionId: `session-${group}`,
        sourceKind: 'inbound',
        messageId: `message-${group}`,
        role: 'user',
        timestamp: '2026-01-02T00:00:00Z',
        content: 'portable runtime architecture',
      });
    }
    expect(searchSessions({ agentGroupId: 'a', query: 'portable runtime' })).toEqual([
      expect.objectContaining({ sessionId: 'session-a', messageId: 'message-a', role: 'user' }),
    ]);
  });

  it('upserts without duplicating FTS rows and cascades session deletion', () => {
    const document = {
      agentGroupId: 'a',
      sessionId: 'session-a',
      sourceKind: 'outbound' as const,
      messageId: 'message',
      role: 'assistant' as const,
      timestamp: '2026-01-02T00:00:00Z',
      content: 'first value',
    };
    upsertSessionSearchDocument(document);
    upsertSessionSearchDocument({ ...document, content: 'second value' });
    expect(countSessionSearchDocuments('a')).toBe(1);
    expect(searchSessions({ agentGroupId: 'a', query: 'second' })).toHaveLength(1);
    expect(searchSessions({ agentGroupId: 'a', query: 'first' })).toHaveLength(0);
  });
});
