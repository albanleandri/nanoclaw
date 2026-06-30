import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from '../db/index.js';
import { INBOUND_SCHEMA } from '../db/schema.js';
import type { Session } from '../types.js';
import { handleSessionSearch } from './action.js';
import { upsertSessionSearchDocument } from './store.js';

const session: Session = {
  id: 'session-a',
  agent_group_id: 'a',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'a', name: 'a', folder: 'a', agent_provider: null, created_at: session.created_at });
  createSession(session);
});
afterEach(closeDb);

describe('session search host action', () => {
  it('derives agent scope and writes one stable system response', async () => {
    upsertSessionSearchDocument({
      agentGroupId: 'a',
      sessionId: session.id,
      sourceKind: 'inbound',
      messageId: 'm',
      role: 'user',
      timestamp: session.created_at,
      content: 'scoped runtime',
    });
    const inbound = new Database(':memory:');
    inbound.exec(INBOUND_SCHEMA);
    await handleSessionSearch({ requestId: 'r', query: 'runtime' }, session, inbound);
    await handleSessionSearch({ requestId: 'r', query: 'runtime' }, session, inbound);
    const rows = inbound.prepare("SELECT content FROM messages_in WHERE kind='system'").all() as Array<{
      content: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content)).toMatchObject({
      requestId: 'r',
      untrusted: true,
      results: [expect.objectContaining({ messageId: 'm' })],
    });
    inbound.close();
  });
});
