/**
 * D4 — the scheduling MCP surface is one tool wide.
 *
 * `ncl tasks` replaced list/update/cancel/pause/resume for every provider that
 * can run a CLI. `openai-protocol-loop` cannot: it resolves its protocol tools
 * from listRegisteredToolDefinitions() (see tool-loop/conformance.test.ts) and
 * has no `ncl` path at all, so `schedule_task` survives as a registered-but-
 * unexposed shim. Exposure to Claude/Codex is cut separately in
 * mcp-tools/server.ts.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { scheduleTask } from './scheduling.js';
import { listRegisteredToolDefinitions } from './server.js';

const REMOVED_TOOLS = ['list_tasks', 'cancel_task', 'pause_task', 'resume_task', 'update_task'];

describe('scheduling MCP tools', () => {
  afterEach(() => {
    closeSessionDb();
  });

  // Regression for D4 — deleting schedule_task too would leave openai-protocol-loop
  // with no way to schedule anything; re-adding any of the other five would give
  // agents a second, unauthorized control plane beside `ncl tasks`.
  it('registers schedule_task and none of the five tools ncl tasks replaced', () => {
    const names = listRegisteredToolDefinitions().map((d) => d.tool.name);
    expect(names).toContain('schedule_task');
    for (const gone of REMOVED_TOOLS) {
      expect(names).not.toContain(gone);
    }
  });

  it('routes a scheduled task into an isolated per-series session', async () => {
    initTestSessionDb();

    const res = await scheduleTask.handler({ prompt: 'say hi', processAfter: '2099-01-01T00:00:00' });
    expect(res.isError).toBeUndefined();

    const action = getUndeliveredMessages()
      .filter((m) => m.kind === 'system')
      .map((m) => JSON.parse(m.content) as Record<string, unknown>)
      .find((c) => c.action === 'schedule_task');
    expect(action).toBeDefined();
    // The host resolves the series session; the container only names the series.
    // The charset is load-bearing: the id becomes a thread suffix
    // (`system:tasks:<id>`) and a filename (`tasks/<id>.md`) on the host.
    expect(action!.seriesId).toMatch(/^[a-z0-9-]+$/);
    expect(action!.prompt).toBe('say hi');
    expect(typeof action!.processAfter).toBe('string');
  });

  it('rejects a schedule_task call with an unparseable processAfter', async () => {
    initTestSessionDb();

    const res = await scheduleTask.handler({ prompt: 'say hi', processAfter: 'not-a-timestamp' });
    expect(res.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
