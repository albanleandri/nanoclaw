import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from './index.js';
import {
  createContainerConfig,
  ensureContainerConfig,
  getAllContainerConfigs,
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
  deleteContainerConfig,
} from './container-configs.js';

function now() {
  return new Date().toISOString();
}

function seedAgentGroup(id: string) {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

function makeConfig(agentGroupId: string) {
  return {
    agent_group_id: agentGroupId,
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
    updated_at: now(),
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('getContainerConfig', () => {
  it('returns undefined for unknown agent group', () => {
    expect(getContainerConfig('no-such-group')).toBeUndefined();
  });

  it('returns the config after create', () => {
    seedAgentGroup('ag-1');
    createContainerConfig(makeConfig('ag-1'));
    const row = getContainerConfig('ag-1');
    expect(row).toBeDefined();
    expect(row!.agent_group_id).toBe('ag-1');
    expect(row!.cli_scope).toBe('group');
    expect(row!.skills).toBe('"all"');
  });
});

describe('getAllContainerConfigs', () => {
  it('returns empty array when no configs exist', () => {
    expect(getAllContainerConfigs()).toEqual([]);
  });

  it('returns all config rows', () => {
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
    createContainerConfig(makeConfig('ag-1'));
    createContainerConfig(makeConfig('ag-2'));
    expect(getAllContainerConfigs()).toHaveLength(2);
  });
});

describe('ensureContainerConfig', () => {
  it('creates a row with defaults when none exists', () => {
    seedAgentGroup('ag-1');
    ensureContainerConfig('ag-1');
    expect(getContainerConfig('ag-1')).toBeDefined();
  });

  it('is idempotent — does not overwrite an existing row', () => {
    seedAgentGroup('ag-1');
    createContainerConfig({ ...makeConfig('ag-1'), cli_scope: 'global' });
    ensureContainerConfig('ag-1');
    expect(getContainerConfig('ag-1')!.cli_scope).toBe('global');
  });
});

describe('updateContainerConfigScalars', () => {
  beforeEach(() => {
    seedAgentGroup('ag-1');
    createContainerConfig(makeConfig('ag-1'));
  });

  it('updates a single scalar field', () => {
    updateContainerConfigScalars('ag-1', { model: 'claude-opus-4-7' });
    expect(getContainerConfig('ag-1')!.model).toBe('claude-opus-4-7');
  });

  it('updates multiple scalar fields at once', () => {
    updateContainerConfigScalars('ag-1', { provider: 'anthropic', cli_scope: 'global' });
    const row = getContainerConfig('ag-1')!;
    expect(row.provider).toBe('anthropic');
    expect(row.cli_scope).toBe('global');
  });

  it('no-ops when updates is empty', () => {
    const before = getContainerConfig('ag-1')!.updated_at;
    updateContainerConfigScalars('ag-1', {});
    expect(getContainerConfig('ag-1')!.updated_at).toBe(before);
  });

  it('throws on an invalid scalar column', () => {
    expect(() => updateContainerConfigScalars('ag-1', { ['bad_col' as never]: 'x' })).toThrow('Invalid scalar column');
  });
});

describe('updateContainerConfigJson', () => {
  beforeEach(() => {
    seedAgentGroup('ag-1');
    createContainerConfig(makeConfig('ag-1'));
  });

  it('overwrites a JSON column wholesale', () => {
    updateContainerConfigJson('ag-1', 'packages_apt', ['curl', 'jq']);
    const row = getContainerConfig('ag-1')!;
    expect(JSON.parse(row.packages_apt)).toEqual(['curl', 'jq']);
  });

  it('overwrites mcp_servers with a map', () => {
    const server = { command: 'npx', args: ['-y', '@foo/bar'], env: {} };
    updateContainerConfigJson('ag-1', 'mcp_servers', { 'my-tool': server });
    const row = getContainerConfig('ag-1')!;
    expect(JSON.parse(row.mcp_servers)['my-tool'].command).toBe('npx');
  });

  it('overwrites shared_resources wholesale', () => {
    updateContainerConfigJson('ag-1', 'shared_resources', ['knowledge', 'docs']);
    const row = getContainerConfig('ag-1')!;
    expect(JSON.parse(row.shared_resources)).toEqual(['knowledge', 'docs']);
  });

  it('throws on an invalid JSON column', () => {
    expect(() => updateContainerConfigJson('ag-1', 'bad_col' as never, [])).toThrow('Invalid JSON column');
  });
});

describe('deleteContainerConfig', () => {
  it('removes the config row', () => {
    seedAgentGroup('ag-1');
    createContainerConfig(makeConfig('ag-1'));
    deleteContainerConfig('ag-1');
    expect(getContainerConfig('ag-1')).toBeUndefined();
  });

  it('is a no-op on a non-existent row', () => {
    expect(() => deleteContainerConfig('ghost')).not.toThrow();
  });
});
