import { describe, expect, it } from 'vitest';

import { runAvailabilityCheck, type AvailabilityContext } from './availability.js';
import type { CapabilityAdapter } from './capability-manifest.js';

const context: AvailabilityContext = {
  configuredMcpServers: new Set(['browser']),
  writableWorkspace: true,
};

describe('availability checks', () => {
  it('matches the MCP server encoded in the adapter entrypoint', () => {
    expect(runAvailabilityCheck('mcp-server-configured', context, { kind: 'mcp', entrypoint: 'mcp:browser' })).toBe(
      true,
    );
    expect(runAvailabilityCheck('mcp-server-configured', context, { kind: 'mcp', entrypoint: 'mcp:filesystem' })).toBe(
      false,
    );
  });

  it('fails closed for unknown check names', () => {
    const adapter: CapabilityAdapter = { kind: 'mcp', entrypoint: 'mcp:browser' };
    expect(runAvailabilityCheck('no-such-check', context, adapter)).toBe(false);
  });
});
