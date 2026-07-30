/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { setCurrentInReplyTo, clearCurrentInReplyTo } from '../current-batch.js';
import { sendFile, sendMessage } from './core.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  clearCurrentInReplyTo();
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps current batch in_reply_to on outbound rows', async () => {
    setCurrentInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // No setCurrentInReplyTo before this call — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  it('suppresses internal-only messages', async () => {
    const result = await sendMessage.handler({ to: 'peer', text: '<internal>Daily DD delivered elsewhere.</internal>' });

    expect(result.isError).toBeUndefined();
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('strips internal blocks before writing outbound text', async () => {
    await sendMessage.handler({ to: 'peer', text: 'visible <internal>hidden</internal> text' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('visible  text');
  });
});

describe('send_message MCP tool — one-door rule for task sessions', () => {
  // Regression for the ncl-tasks port — a task fire has no origin chat, so
  // "reply in place" is meaningless and the single-destination shortcut would
  // silently pick an arbitrary target. One door: name the destination.

  function seedRouting(routing: {
    channel_type: string | null;
    platform_id: string | null;
    thread_id: string | null;
    is_task: 0 | 1;
  }) {
    getInboundDb()
      .prepare(
        `INSERT INTO session_routing (id, channel_type, platform_id, thread_id, is_task)
         VALUES (1, ?, ?, ?, ?)`,
      )
      .run(routing.channel_type, routing.platform_id, routing.thread_id, routing.is_task);
  }

  function seedDestinations(
    destinations: Array<{
      name: string;
      type: string;
      channel_type: string | null;
      platform_id: string | null;
    }>,
  ) {
    const db = getInboundDb();
    for (const d of destinations) {
      db.prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      ).run(d.name, d.name, d.type, d.channel_type, d.platform_id);
    }
  }

  it('refuses to infer a destination in a task session', async () => {
    seedRouting({ channel_type: null, platform_id: null, thread_id: 'system:tasks:daily-1a2b', is_task: 1 });
    seedDestinations([{ name: 'boss', type: 'channel', channel_type: 'telegram', platform_id: 'chat-1' }]);

    const res = await sendMessage.handler({ text: 'hi' });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('task session');
    expect(res.content[0].text).toContain('boss');
    expect(getUndeliveredMessages().filter((m) => m.kind !== 'system')).toHaveLength(0);
  });

  it('still delivers from a task session when `to` is explicit', async () => {
    seedRouting({ channel_type: null, platform_id: null, thread_id: 'system:tasks:daily-1a2b', is_task: 1 });
    seedDestinations([{ name: 'boss', type: 'channel', channel_type: 'telegram', platform_id: 'chat-1' }]);

    const res = await sendMessage.handler({ to: 'boss', text: 'hi' });

    expect(res.isError).toBeUndefined();
    expect(getUndeliveredMessages().filter((m) => m.kind !== 'system')).toHaveLength(1);
  });

  it('keeps the single-destination shortcut in a chat session', async () => {
    seedRouting({ channel_type: 'telegram', platform_id: 'chat-1', thread_id: 'thread-1', is_task: 0 });
    seedDestinations([{ name: 'boss', type: 'channel', channel_type: 'telegram', platform_id: 'chat-1' }]);

    const res = await sendMessage.handler({ text: 'hi' });

    expect(res.isError).toBeUndefined();
  });
});

describe('send_file MCP tool — filename safety', () => {
  it('rejects a traversal filename and writes nothing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'send-file-'));
    const src = path.join(tmp, 'real.txt');
    fs.writeFileSync(src, 'data');

    const result = await sendFile.handler({ to: 'peer', path: src, filename: '../escape.txt' });

    expect(result.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);

    fs.rmSync(tmp, { recursive: true });
  });
});
