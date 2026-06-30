import { describe, expect, it } from 'bun:test';

import { callRegisteredTool, listRegisteredToolDefinitions, registerTools } from './server.js';

describe('in-process MCP tool catalog', () => {
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
