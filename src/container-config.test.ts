import { describe, expect, it } from 'vitest';

import { configFromDb } from './container-config.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

function baseRow(overrides: Partial<ContainerConfigRow> = {}): ContainerConfigRow {
  return {
    agent_group_id: 'ag-1',
    provider: null,
    model: null,
    effort: null,
    image_tag: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    skills: '"all"',
    mcp_servers: '{}',
    packages_apt: '[]',
    packages_npm: '[]',
    additional_mounts: '[]',
    cli_scope: 'group',
    shared_resources: '[]',
    updated_at: '2026-06-19T00:00:00.000Z',
    ...overrides,
  };
}

const group: AgentGroup = {
  id: 'ag-1',
  name: 'Test Group',
  folder: 'test-group',
  agent_provider: null,
  created_at: '2026-06-19T00:00:00.000Z',
};

describe('configFromDb sharedResources mapping', () => {
  it('parses an explicit shared_resources list', () => {
    const row = baseRow({ shared_resources: '["knowledge","docs"]' });
    expect(configFromDb(row, group).sharedResources).toEqual(['knowledge', 'docs']);
  });

  it('defaults to an empty array', () => {
    const row = baseRow({ shared_resources: '[]' });
    expect(configFromDb(row, group).sharedResources).toEqual([]);
  });
});
