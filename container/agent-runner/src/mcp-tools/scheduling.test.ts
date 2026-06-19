import { afterEach, describe, expect, it } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from '../db/connection.js';
import { listTasks } from './scheduling.js';

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

describe('list_tasks MCP host-mediated flow', () => {
  afterEach(() => {
    closeSessionDb();
  });

  it('requests the task list from the host, formats the response, and acknowledges it', async () => {
    const { inbound, outbound } = initTestSessionDb();

    const resultPromise = listTasks.handler({});

    const out = await waitFor(() =>
      outbound.prepare("SELECT id, content FROM messages_out WHERE kind = 'system' LIMIT 1").get() as
        | { id: string; content: string }
        | undefined,
    );
    const request = JSON.parse(out.content) as { action: string; requestId: string };
    expect(request.action).toBe('list_tasks');
    expect(request.requestId).toBe(out.id);

    inbound
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
         VALUES (?, ?, 'system', datetime('now'), 'pending', 0, ?)`,
      )
      .run(
        'schedule-admin-response-1',
        2,
        JSON.stringify({
          action: 'schedule_admin_response',
          requestId: request.requestId,
          ok: true,
          tasks: [
            {
              id: 'task-shared-1',
              status: 'pending',
              process_after: '2026-06-20T07:30:00.000Z',
              recurrence: '0 7 * * *',
              content: JSON.stringify({ prompt: 'Shared schedule task for Codex visibility' }),
            },
          ],
        }),
      );

    const result = await resultPromise;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('task-shared-1 [pending]');
    expect(result.content[0].text).toContain('Shared schedule task for Codex visibility');

    const ack = outbound
      .prepare("SELECT status FROM processing_ack WHERE message_id = ?")
      .get('schedule-admin-response-1') as { status: string } | undefined;
    expect(ack?.status).toBe('completed');
  });
});
