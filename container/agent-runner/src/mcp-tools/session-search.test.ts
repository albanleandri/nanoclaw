import { afterEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import { sessionSearch } from './session-search.js';

async function waitFor<T>(fn: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const value = fn();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

describe('session_search MCP tool', () => {
  afterEach(closeSessionDb);

  it('uses a correlated host request and acknowledges its response', async () => {
    const { inbound, outbound } = initTestSessionDb();
    const pending = sessionSearch.handler({ query: 'runtime', limit: 2 });
    const out = await waitFor(
      () =>
        outbound.prepare("SELECT id, content FROM messages_out WHERE kind='system'").get() as
          | { id: string; content: string }
          | undefined,
    );
    const request = JSON.parse(out.content) as { requestId: string; action: string };
    expect(request.action).toBe('session_search');
    inbound
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
         VALUES (?, 2, 'system', datetime('now'), 'pending', 0, ?)`,
      )
      .run(
        'response',
        JSON.stringify({
          action: 'session_search_response',
          requestId: request.requestId,
          ok: true,
          results: [{ sessionId: 's', messageId: 'm', excerpt: 'runtime' }],
        }),
      );
    const result = await pending;
    expect(result.content[0]?.text).toContain('"untrusted":true');
    expect(result.content[0]?.text).toContain('"messageId":"m"');
    expect(outbound.prepare('SELECT status FROM processing_ack WHERE message_id=?').get('response')).toEqual({
      status: 'completed',
    });
  });
});
