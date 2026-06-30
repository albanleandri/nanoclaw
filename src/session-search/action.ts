import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../delivery.js';
import { insertMessage } from '../db/session-db.js';
import type { Session } from '../types.js';
import { searchSessions } from './store.js';

export async function handleSessionSearch(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const requestId = typeof content.requestId === 'string' ? content.requestId : '';
  const query = typeof content.query === 'string' ? content.query : '';
  if (!requestId || !query.trim()) throw new Error('session_search requires requestId and query');
  const results = searchSessions({
    agentGroupId: session.agent_group_id,
    query,
    limit: typeof content.limit === 'number' ? content.limit : undefined,
  });
  const id = `session-search-response:${requestId}`;
  const response = JSON.stringify({
    action: 'session_search_response',
    requestId,
    ok: true,
    untrusted: true,
    results,
  });
  const existing = _inDb.prepare('SELECT kind, content FROM messages_in WHERE id = ?').get(id) as
    | { kind: string; content: string }
    | undefined;
  if (existing) {
    if (existing.kind !== 'system' || existing.content !== response)
      throw new Error(`Session search response conflict`);
    return;
  }
  insertMessage(_inDb, {
    id,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: response,
    processAfter: null,
    recurrence: null,
    trigger: 0,
  });
}

registerDeliveryAction('session_search', handleSessionSearch);
