import { describe, expect, it } from 'vitest';

import { requireRuntimeDescriptor } from '../providers/runtime-descriptor-registry.js';
import '../providers/runtime-descriptors/index.js';
import type { AvailabilityContext } from './availability.js';
import type { CapabilityManifest } from './capability-manifest.js';
import { resolveCapabilitySupport } from './resolve-support.js';

const hostAction: CapabilityManifest = {
  id: 'nanoclaw.send-message',
  version: 1,
  description: 'Send a message.',
  requirements: {},
  sideEffects: 'external-write',
  approval: 'never',
  adapters: [{ kind: 'host-action', entrypoint: 'host:send-message' }],
};

const browser: CapabilityManifest = {
  id: 'web.browse',
  version: 1,
  description: 'Browse the web.',
  requirements: { mcp: true },
  sideEffects: 'none',
  approval: 'policy',
  adapters: [
    {
      kind: 'mcp',
      runtimeIds: ['claude-sdk'],
      entrypoint: 'mcp:browser',
      availabilityCheck: 'mcp-server-configured',
    },
  ],
};

const withBrowser: AvailabilityContext = {
  configuredMcpServers: new Set(['browser']),
  writableWorkspace: true,
};
const noServers: AvailabilityContext = { configuredMcpServers: new Set(), writableWorkspace: true };

describe('resolveCapabilitySupport', () => {
  it('bridges host actions even on tool-less runtimes', () => {
    expect(
      resolveCapabilitySupport(hostAction, requireRuntimeDescriptor('openai-protocol-loop'), noServers, {
        writableWorkspace: true,
      }).support,
    ).toBe('bridged');
  });

  it('bridges available MCP adapters and rejects unavailable ones', () => {
    const runtime = requireRuntimeDescriptor('claude-sdk');
    expect(resolveCapabilitySupport(browser, runtime, withBrowser, { writableWorkspace: true }).support).toBe(
      'bridged',
    );
    const unavailable = resolveCapabilitySupport(browser, runtime, noServers, { writableWorkspace: true });
    expect(unavailable.support).toBe('unsupported');
    expect(unavailable.reason).toMatch(/availability/i);
  });

  it('rejects adapters that do not match the runtime', () => {
    expect(
      resolveCapabilitySupport(browser, requireRuntimeDescriptor('openai-protocol-loop'), withBrowser, {
        writableWorkspace: true,
      }).support,
    ).toBe('unsupported');
  });

  it('selects protocol tools only for a verified tool-capable endpoint', () => {
    const manifest: CapabilityManifest = {
      ...hostAction,
      adapters: [
        { kind: 'host-action', entrypoint: 'host:send-message' },
        {
          kind: 'protocol-tool',
          runtimeIds: ['openai-protocol-loop'],
          entrypoint: 'tool:send_message',
        },
      ],
    };
    const runtime = requireRuntimeDescriptor('openai-protocol-loop');
    expect(
      resolveCapabilitySupport(manifest, runtime, noServers, { writableWorkspace: true }, { toolCalling: 'native' }),
    ).toMatchObject({ support: 'bridged', adapter: { kind: 'protocol-tool' } });
    expect(
      resolveCapabilitySupport(manifest, runtime, noServers, { writableWorkspace: true }, { toolCalling: 'none' }),
    ).toMatchObject({ support: 'bridged', adapter: { kind: 'host-action' } });
  });
});
