import { describe, expect, it } from 'vitest';

import { buildAgentProfile } from './agent-profile.js';
import type { ContainerConfig } from './container-config.js';
import type { AgentGroup } from './types.js';

const group: AgentGroup = {
  id: 'ag-1',
  name: 'Research Agent',
  folder: 'research-agent',
  agent_provider: null,
  created_at: '2026-06-20T00:00:00.000Z',
};

function config(overrides: Partial<ContainerConfig> = {}): ContainerConfig {
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    ...overrides,
  };
}

describe('buildAgentProfile', () => {
  it('derives identity from group and assistant config', () => {
    expect(buildAgentProfile(group, config()).assistantName).toBe('Research Agent');
    expect(buildAgentProfile(group, config({ assistantName: 'Ada' })).assistantName).toBe('Ada');
  });

  it('passes through selected skills and MCP servers', () => {
    const mcpServers = {
      files: {
        command: 'node',
        args: ['server.js'],
        env: { MODE: 'test' },
      },
    };

    const profile = buildAgentProfile(
      group,
      config({
        skills: ['calendar', 'stocks'],
        mcpServers,
      }),
    );

    expect(profile.tools.skills).toEqual(['calendar', 'stocks']);
    expect(profile.tools.mcpServers).toBe(mcpServers);
  });

  it('defaults shared resources and workspace conventions', () => {
    const profile = buildAgentProfile(group, config());

    expect(profile.resources.sharedResources).toEqual([]);
    expect(profile.memory.workspacePath).toBe('/workspace/agent');
    expect(profile.memory.localMemoryFile).toBe('CLAUDE.local.md');
    expect(profile.memory.neutralMemoryRoot).toBe('/workspace/agent/memory');
  });

  it('includes shared resources and CLI scope when configured', () => {
    const profile = buildAgentProfile(
      group,
      config({
        cliScope: 'global',
        sharedResources: ['knowledge', 'docs'],
      }),
    );

    expect(profile.tools.cliScope).toBe('global');
    expect(profile.resources.sharedResources).toEqual(['knowledge', 'docs']);
  });
});
