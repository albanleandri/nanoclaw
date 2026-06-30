import { getDb } from '../db/connection.js';

export interface SessionSearchDocument {
  agentGroupId: string;
  sessionId: string;
  sourceKind: 'inbound' | 'outbound';
  messageId: string;
  role: 'user' | 'assistant';
  timestamp: string;
  content: string;
}

export interface SessionSearchResult {
  sessionId: string;
  messageId: string;
  sourceKind: 'inbound' | 'outbound';
  role: 'user' | 'assistant';
  timestamp: string;
  excerpt: string;
}

export function upsertSessionSearchDocument(document: SessionSearchDocument): void {
  getDb()
    .prepare(
      `INSERT INTO session_search_documents
       (agent_group_id, session_id, source_kind, message_id, role, source_timestamp, content)
       VALUES (@agentGroupId, @sessionId, @sourceKind, @messageId, @role, @timestamp, @content)
       ON CONFLICT(session_id, source_kind, message_id) DO UPDATE SET
         agent_group_id=excluded.agent_group_id,
         role=excluded.role,
         source_timestamp=excluded.source_timestamp,
         content=excluded.content`,
    )
    .run(document);
}

function ftsQuery(value: string): string {
  const terms = value
    .normalize('NFKC')
    .split(/\s+/)
    .map((term) => term.replaceAll('"', '').trim())
    .filter(Boolean)
    .slice(0, 16);
  if (terms.length === 0) throw new Error('Session search query is empty');
  return terms.map((term) => `"${term}"`).join(' AND ');
}

export function searchSessions(input: { agentGroupId: string; query: string; limit?: number }): SessionSearchResult[] {
  if (!input.agentGroupId.trim()) throw new Error('Session search agent scope is required');
  const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
  return getDb()
    .prepare(
      `SELECT d.session_id AS sessionId, d.message_id AS messageId,
              d.source_kind AS sourceKind, d.role, d.source_timestamp AS timestamp,
              snippet(session_search_fts, 0, '', '', ' … ', 24) AS excerpt
       FROM session_search_fts
       JOIN session_search_documents d ON d.id = session_search_fts.rowid
       WHERE session_search_fts MATCH @query AND d.agent_group_id = @agentGroupId
       ORDER BY bm25(session_search_fts), d.source_timestamp DESC, d.id DESC
       LIMIT @limit`,
    )
    .all({ agentGroupId: input.agentGroupId, query: ftsQuery(input.query), limit }) as SessionSearchResult[];
}

export function countSessionSearchDocuments(agentGroupId?: string): number {
  const row = agentGroupId
    ? getDb()
        .prepare('SELECT COUNT(*) AS count FROM session_search_documents WHERE agent_group_id = ?')
        .get(agentGroupId)
    : getDb().prepare('SELECT COUNT(*) AS count FROM session_search_documents').get();
  return (row as { count: number }).count;
}
