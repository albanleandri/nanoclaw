/**
 * Container half of the MCP tool/capability contract.
 *
 * Every audited MCP tool emits `tool:<name>` as its capability-audit entrypoint, and the
 * host rejects any entrypoint the capability manifest does not declare. The two packages
 * share no modules, so both sides assert against contracts/mcp-tool-capabilities.json
 * independently. Regression: nanoclaw.schedule-task drifted and the host dropped 1,314
 * audit events before anyone noticed.
 */
import { describe, expect, it } from 'bun:test';

import { listRegisteredToolDefinitions } from './server.js';
import './catalog.js';

const contract = (await Bun.file(
  new URL('../../../../contracts/mcp-tool-capabilities.json', import.meta.url).pathname,
).json()) as Array<{ capabilityId: string; toolName: string }>;

describe('MCP tool capability contract', () => {
  it('binds every registered tool to the capability the host expects', () => {
    const runnerBindings = listRegisteredToolDefinitions()
      .filter((definition) => definition.audit)
      .map((definition) => ({ capabilityId: definition.audit!.capabilityId, toolName: definition.tool.name }))
      .sort((a, b) => a.capabilityId.localeCompare(b.capabilityId) || a.toolName.localeCompare(b.toolName));

    expect(runnerBindings).toEqual(contract);
  });
});
