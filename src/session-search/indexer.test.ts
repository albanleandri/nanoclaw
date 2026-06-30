import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from '../db/index.js';
import { indexSessionMessage } from './indexer.js';
import { countSessionSearchDocuments, searchSessions } from './store.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'a', name: 'a', folder: 'a', agent_provider: null, created_at: '2026-01-01T00:00:00Z' });
  createSession({
    id: 's',
    agent_group_id: 'a',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-01-01T00:00:00Z',
  });
});
afterEach(closeDb);

describe('session search indexer', () => {
  it('is idempotent and ignores non-visible traffic', () => {
    const visible = {
      agentGroupId: 'a',
      sessionId: 's',
      sourceKind: 'inbound' as const,
      messageId: 'm',
      timestamp: '2026-01-01T00:00:00Z',
      kind: 'chat',
      channelType: 'telegram',
      content: JSON.stringify({ text: 'remember this phrase' }),
    };
    expect(indexSessionMessage(visible)).toBe(true);
    expect(indexSessionMessage(visible)).toBe(true);
    expect(indexSessionMessage({ ...visible, messageId: 'system', kind: 'system', content: '{"text":"hidden"}' })).toBe(
      false,
    );
    expect(countSessionSearchDocuments('a')).toBe(1);
    expect(searchSessions({ agentGroupId: 'a', query: 'remember phrase' })).toHaveLength(1);
  });
});
