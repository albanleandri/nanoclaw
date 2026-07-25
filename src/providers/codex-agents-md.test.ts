import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, createContainerConfig, initTestDb, runMigrations } from '../db/index.js';
import type { AgentGroup } from '../types.js';
import { composeGroupAgentsMd } from './codex-agents-md.js';

const group: AgentGroup = {
  id: 'ag-codex-doc-test',
  name: 'Codex Doc Test',
  folder: 'codex-doc-test',
  agent_provider: 'codex',
  created_at: '2026-06-19T00:00:00.000Z',
};

describe('composeGroupAgentsMd shared knowledge instructions', () => {
  let groupDir: string;
  let previousCwd: string;
  let projectRoot: string;

  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    previousCwd = process.cwd();
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-project-'));
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-agents-md-'));
    process.chdir(projectRoot);
    fs.mkdirSync(path.join(projectRoot, 'container', 'runtime'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'container', 'runtime', 'core.md'),
      [
        '## Token-efficient shell',
        '',
        'Use the NanoClaw `run_shell` MCP tool for shell commands so RTK filtering is provider-neutral.',
        '',
        '## Shared knowledge',
        '',
        '/workspace/agent/shared/knowledge/MEMORY.md',
        'Do not duplicate shared user preferences into provider-specific memory files.',
      ].join('\n'),
    );
    createAgentGroup(group);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    closeDb();
    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('includes the provider-neutral shared knowledge contract for Codex agents', () => {
    composeGroupAgentsMd(group, groupDir);

    const doc = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
    expect(doc).toContain('## Shared knowledge');
    expect(doc).toContain('/workspace/agent/shared/knowledge/MEMORY.md');
    expect(doc).toContain('Do not duplicate shared user preferences into provider-specific memory files.');
    expect(doc).toContain('Use the NanoClaw `run_shell` MCP tool for shell commands');
    expect(doc).not.toContain('CLAUDE.local.md');
    expect(doc).not.toContain("Claude's native");
  });

  it('renders enabled module and MCP instructions through the shared profile boundary', () => {
    const moduleDir = path.join(projectRoot, 'container', 'agent-runner', 'src', 'mcp-tools');
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(path.join(moduleDir, 'scheduling.instructions.md'), 'schedule work through the shared module');
    fs.writeFileSync(path.join(moduleDir, 'cli.instructions.md'), 'do not include cli instructions when disabled');
    // Backing source for the `knowledge` shared resource so it is advertised.
    fs.mkdirSync(path.join(projectRoot, 'groups', 'shared', 'knowledge'), { recursive: true });
    createContainerConfig({
      agent_group_id: group.id,
      provider: 'codex',
      model: null,
      effort: null,
      image_tag: null,
      assistant_name: null,
      max_messages_per_prompt: null,
      skills: '"all"',
      mcp_servers: JSON.stringify({ search: { command: 'npx', args: ['search'], instructions: 'search carefully' } }),
      packages_apt: '[]',
      packages_npm: '[]',
      additional_mounts: '[]',
      cli_scope: 'disabled',
      shared_resources: '["knowledge"]',
      updated_at: '2026-06-20T00:00:00.000Z',
    });

    composeGroupAgentsMd(group, groupDir);

    const doc = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
    expect(doc).toContain('# NanoClaw Module: scheduling');
    expect(doc).toContain('schedule work through the shared module');
    expect(doc).not.toContain('# NanoClaw Module: cli');
    expect(doc).not.toContain('do not include cli instructions when disabled');
    expect(doc).toContain('# MCP Server: search');
    expect(doc).toContain('search carefully');
    expect(doc).toContain('# Shared Resource: knowledge');
    expect(doc).toContain('/workspace/agent/shared/knowledge');
  });

  it('never reads private memory into the host-composed project document', () => {
    fs.mkdirSync(path.join(groupDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'memory', 'index.md'), '- PRIVATE_SENTINEL');

    composeGroupAgentsMd(group, groupDir);

    const doc = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
    expect(doc).toContain('Top memory index: `/workspace/agent/memory/index.md`.');
    expect(doc).not.toContain('PRIVATE_SENTINEL');
  });
});
