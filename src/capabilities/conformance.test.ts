import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';

import { listRuntimeDescriptors } from '../providers/runtime-descriptor-registry.js';
import '../providers/runtime-descriptors/index.js';
import { listCapabilities } from './capability-registry.js';
import './builtins/index.js';
import { resolveCapabilitySupport } from './resolve-support.js';

const SUPPORT = new Set(['native', 'bridged', 'degraded', 'unsupported']);
const protocolToolContract = JSON.parse(
  readFileSync(new URL('../../contracts/protocol-tools.json', import.meta.url), 'utf8'),
) as Array<{ capabilityId: string; toolName: string }>;
const mcpToolContract = JSON.parse(
  readFileSync(new URL('../../contracts/mcp-tool-capabilities.json', import.meta.url), 'utf8'),
) as Array<{ capabilityId: string; toolName: string }>;

describe('runtime by capability conformance matrix', () => {
  const runtimes = listRuntimeDescriptors();
  const capabilities = listCapabilities();

  it('contains the core runtimes and built-in capabilities', () => {
    expect(runtimes.map((item) => item.id)).toEqual(
      expect.arrayContaining(['claude-sdk', 'codex-app-server', 'openai-protocol-loop']),
    );
    expect(capabilities.length).toBeGreaterThanOrEqual(4);
  });

  it('returns an explicit support level for every matrix cell', () => {
    for (const runtime of runtimes) {
      for (const capability of capabilities) {
        for (const configuredMcpServers of [new Set<string>(), new Set(['browser', 'filesystem'])]) {
          const resolved = resolveCapabilitySupport(
            capability,
            runtime,
            { configuredMcpServers, writableWorkspace: true },
            { writableWorkspace: true },
          );
          expect(SUPPORT.has(resolved.support), `${capability.id} on ${runtime.id}`).toBe(true);
        }
      }
    }
  });

  it('bridges required host actions on the tool-less runtime', () => {
    const runtime = runtimes.find((item) => item.id === 'openai-protocol-loop')!;
    const capability = capabilities.find((item) => item.id === 'nanoclaw.send-message')!;
    expect(
      resolveCapabilitySupport(
        capability,
        runtime,
        { configuredMcpServers: new Set(), writableWorkspace: true },
        { writableWorkspace: true },
      ).support,
    ).toBe('bridged');
  });

  it('keeps compiled protocol entrypoints aligned with the checked-in runner contract', () => {
    const hostBindings = capabilities
      .flatMap((capability) =>
        capability.adapters
          .filter((adapter) => adapter.kind === 'protocol-tool')
          .map((adapter) => ({
            capabilityId: capability.id,
            toolName: adapter.entrypoint.replace(/^tool:/, ''),
          })),
      )
      .sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
    expect(hostBindings).toEqual(
      protocolToolContract.map(({ capabilityId, toolName }) => ({ capabilityId, toolName })),
    );
  });

  // The container emits `tool:<name>` on every audited MCP call and the host rejects any
  // entrypoint a manifest does not declare. Drift here silently drops the audit trail, so
  // the two sides are pinned to contracts/mcp-tool-capabilities.json independently.
  it('declares every MCP tool the runner surfaces for each capability', () => {
    const hostBindings = capabilities
      .flatMap((capability) =>
        (capability.mcpTools ?? []).map((toolName) => ({ capabilityId: capability.id, toolName })),
      )
      .sort((a, b) => a.capabilityId.localeCompare(b.capabilityId) || a.toolName.localeCompare(b.toolName));
    expect(hostBindings).toEqual(mcpToolContract.map(({ capabilityId, toolName }) => ({ capabilityId, toolName })));
  });
});
