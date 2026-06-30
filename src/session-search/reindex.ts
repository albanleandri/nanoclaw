import Database from 'better-sqlite3';
import fs from 'fs';

import { getDb } from '../db/connection.js';
import { inboundDbPath, outboundDbPath } from '../session-manager.js';
import { indexSessionMessage } from './indexer.js';

export interface ReindexResult {
  sessions: number;
  scanned: number;
  indexed: number;
}

export function reindexSessionSearch(options: { dryRun?: boolean; limitPerDb?: number } = {}): ReindexResult {
  const sessions = getDb().prepare('SELECT id, agent_group_id FROM sessions ORDER BY created_at').all() as Array<{
    id: string;
    agent_group_id: string;
  }>;
  const result: ReindexResult = { sessions: 0, scanned: 0, indexed: 0 };
  const limit = Math.max(1, Math.min(options.limitPerDb ?? 5_000, 50_000));
  for (const session of sessions) {
    let found = false;
    for (const [sourceKind, dbPath, table] of [
      ['inbound', inboundDbPath(session.agent_group_id, session.id), 'messages_in'],
      ['outbound', outboundDbPath(session.agent_group_id, session.id), 'messages_out'],
    ] as const) {
      if (!fs.existsSync(dbPath)) continue;
      found = true;
      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db
          .prepare(
            `SELECT id, kind, timestamp, channel_type, content
             FROM ${table} ORDER BY timestamp, id LIMIT ?`,
          )
          .all(limit) as Array<{
          id: string;
          kind: string;
          timestamp: string;
          channel_type: string | null;
          content: string;
        }>;
        for (const row of rows) {
          result.scanned += 1;
          if (options.dryRun) continue;
          if (
            indexSessionMessage({
              agentGroupId: session.agent_group_id,
              sessionId: session.id,
              sourceKind,
              messageId: row.id,
              timestamp: row.timestamp,
              kind: row.kind,
              channelType: row.channel_type,
              content: row.content,
            })
          ) {
            result.indexed += 1;
          }
        }
      } finally {
        db.close();
      }
    }
    if (found) result.sessions += 1;
  }
  return result;
}
