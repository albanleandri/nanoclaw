import { describe, expect, it } from 'bun:test';

import { callRegisteredTool, listRegisteredToolDefinitions, registerTools } from './server.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../db/connection.js';
import './catalog.js';

describe('in-process MCP tool catalog', () => {
  it('registers the provider-neutral RTK shell tool', () => {
    expect(listRegisteredToolDefinitions().map((definition) => definition.tool.name)).toContain('run_shell');
  });

  it('lists and invokes registered definitions without starting stdio', async () => {
    const name = 'catalog_test_tool';
    registerTools([
      {
        tool: { name, description: 'test', inputSchema: { type: 'object', properties: {} } },
        handler: async () => ({ content: [{ type: 'text', text: 'called' }] }),
      },
    ]);
    expect(listRegisteredToolDefinitions().map((definition) => definition.tool.name)).toContain(name);
    await expect(callRegisteredTool(name, {})).resolves.toEqual({
      content: [{ type: 'text', text: 'called' }],
    });
  });

  it('returns a typed error for unknown tools and keeps first registration on duplicates', async () => {
    await expect(callRegisteredTool('missing_catalog_tool', {})).resolves.toMatchObject({ isError: true });
    const name = 'catalog_duplicate_tool';
    registerTools([
      {
        tool: { name, description: 'first', inputSchema: { type: 'object', properties: {} } },
        handler: async () => ({ content: [{ type: 'text', text: 'first' }] }),
      },
    ]);
    registerTools([
      {
        tool: { name, description: 'second', inputSchema: { type: 'object', properties: {} } },
        handler: async () => ({ content: [{ type: 'text', text: 'second' }] }),
      },
    ]);
    await expect(callRegisteredTool(name, {})).resolves.toEqual({
      content: [{ type: 'text', text: 'first' }],
    });
  });
});

describe('canonical capability audit', () => {
  it('emits redacted lifecycle rows around a canonical native tool', async () => {
    const { outbound } = initTestSessionDb();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'peer')`,
      )
      .run();
    await callRegisteredTool('send_message', { to: 'peer', text: 'sensitive body' });
    const rows = outbound.prepare("SELECT content FROM messages_out WHERE kind='system' ORDER BY seq").all() as Array<{
      content: string;
    }>;
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => JSON.parse(row.content).eventType)).toEqual(['requested', 'started', 'succeeded']);
    expect(rows.every((row) => !row.content.includes('sensitive body'))).toBe(true);
    const firstHash = JSON.parse(rows[0].content).argsSha256;
    await callRegisteredTool('send_message', { to: 'peer', text: 'different sensitive body' });
    const secondHash = JSON.parse(
      (
        outbound.prepare("SELECT content FROM messages_out WHERE kind='system' ORDER BY seq DESC LIMIT 1").get() as {
          content: string;
        }
      ).content,
    ).argsSha256;
    expect(secondHash).toBe(firstHash);
    closeSessionDb();
  });
});
