import { describe, expect, it } from 'vitest';

import type { ContainerConfig } from '../container-config.js';
import { requireRuntimeDescriptor } from '../providers/runtime-descriptor-registry.js';
import '../providers/runtime-descriptors/index.js';
import {
  applyToolGating,
  buildAvailabilityContext,
  deriveCapabilityProfile,
  runtimeSupportsTools,
} from './spawn-gate.js';

const claude = requireRuntimeDescriptor('claude-sdk');
const openai = requireRuntimeDescriptor('openai-protocol-loop');

function config(mcpServers: ContainerConfig['mcpServers']): ContainerConfig {
  return { mcpServers, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all' };
}

describe('spawn capability gate', () => {
  it('identifies tool-capable runtimes', () => {
    expect(runtimeSupportsTools(claude)).toBe(true);
    expect(runtimeSupportsTools(openai)).toBe(false);
  });

  it('preserves the exact config for tool-capable runtimes', () => {
    const original = config({ browser: { command: 'x' } });
    expect(applyToolGating(original, claude)).toBe(original);
  });

  it('removes MCP servers without mutating config for tool-less runtimes', () => {
    const original = config({ browser: { command: 'x' } });
    expect(applyToolGating(original, openai).mcpServers).toEqual({});
    expect(original.mcpServers).toEqual({ browser: { command: 'x' } });
  });

  it('derives required host actions and optional configured browsing', () => {
    const profile = deriveCapabilityProfile(config({ browser: { command: 'x' } }));
    expect(profile.requested).toEqual(
      expect.arrayContaining(['nanoclaw.send-message', 'nanoclaw.schedule-task', 'web.browse']),
    );
    expect(profile.allowDegraded).toContain('web.browse');
    expect(buildAvailabilityContext(config({ browser: { command: 'x' } })).configuredMcpServers).toEqual(
      new Set(['browser']),
    );
  });
});
