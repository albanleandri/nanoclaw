import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeGroupClaudeMd } from './claude-md-compose.js';
import type { ContainerConfig } from './container-config.js';
import { closeDb, createAgentGroup, createContainerConfig, initTestDb, runMigrations } from './db/index.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

let projectRoot: string;
let previousCwd: string;
let groupFolder: string | null = null;

function now(): string {
  return new Date().toISOString();
}

function writeFile(relativePath: string, content: string): void {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function writeSkill(skillPath: string): void {
  writeFile(path.join('container', 'skills', skillPath, 'instructions.md'), `${skillPath}\n`);
}

function config(agentGroupId: string, overrides: Partial<ContainerConfigRow> = {}): ContainerConfigRow {
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
    ...overrides,
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  previousCwd = process.cwd();
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-claude-compose-output-'));
  process.chdir(projectRoot);
});

afterEach(() => {
  process.chdir(previousCwd);
  closeDb();
  fs.rmSync(projectRoot, { recursive: true, force: true });
  if (groupFolder) {
    fs.rmSync(path.join(previousCwd, 'groups', groupFolder), { recursive: true, force: true });
    groupFolder = null;
  }
});

describe('composeGroupClaudeMd', () => {
  it('renders the existing import-style entry point and reconciles fragments', () => {
    writeFile('container/runtime/core.md', 'runtime core');
    writeFile('container/runtime/claude.md', 'claude memory');
    writeSkill('calendar');
    writeFile('container/agent-runner/src/mcp-tools/scheduling.instructions.md', 'schedule tools');

    const group: AgentGroup = {
      id: 'ag-compose',
      name: 'Compose Test',
      folder: 'compose-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      agent_provider: null,
      created_at: now(),
    };
    groupFolder = group.folder;
    createAgentGroup(group);
    createContainerConfig(
      config(group.id, {
        skills: '["calendar"]',
        mcp_servers: JSON.stringify({
          search: {
            command: 'node',
            args: ['search.js'],
            env: {},
            instructions: 'search tools',
          },
        }),
      }),
    );

    const groupDir = path.join(previousCwd, 'groups', group.folder);
    fs.mkdirSync(path.join(groupDir, '.claude-fragments'), { recursive: true });
    fs.writeFileSync(path.join(groupDir, '.claude-fragments', 'stale.md'), 'stale');

    composeGroupClaudeMd(group);

    expect(fs.readlinkSync(path.join(groupDir, '.claude-fragments', 'skill-calendar.md'))).toBe(
      '/app/skills/calendar/instructions.md',
    );
    expect(fs.readlinkSync(path.join(groupDir, '.claude-fragments', 'module-scheduling.md'))).toBe(
      '/app/src/mcp-tools/scheduling.instructions.md',
    );
    expect(fs.readFileSync(path.join(groupDir, '.claude-fragments', 'mcp-search.md'), 'utf-8')).toBe('search tools');
    expect(fs.existsSync(path.join(groupDir, '.claude-fragments', 'stale.md'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(true);
    expect(fs.readFileSync(path.join(groupDir, '.claude-fragments', 'runtime-contract.md'), 'utf8')).toContain(
      'claude memory',
    );
    expect(fs.readFileSync(path.join(groupDir, '.claude-fragments', 'runtime-contract.md'), 'utf8')).not.toContain(
      'memory/system/definition.md',
    );

    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8')).toBe(
      [
        '<!-- Composed at spawn — do not edit. Edit CLAUDE.local.md for per-group content. -->',
        '@./.claude-fragments/mcp-search.md',
        '@./.claude-fragments/module-scheduling.md',
        '@./.claude-fragments/runtime-contract.md',
        '@./.claude-fragments/skill-calendar.md',
        '',
      ].join('\n'),
    );
  });

  it('keeps capability-filtered provider docs isolated between sessions', () => {
    writeFile('container/runtime/core.md', 'runtime core');
    writeFile('container/runtime/claude.md', 'claude memory');
    writeFile('container/agent-runner/src/mcp-tools/core.instructions.md', 'core tools');
    writeFile('container/agent-runner/src/mcp-tools/scheduling.instructions.md', 'schedule tools');
    const group: AgentGroup = {
      id: 'ag-isolated-compose',
      name: 'Isolated Compose',
      folder: 'isolated-compose-' + Date.now(),
      agent_provider: null,
      created_at: now(),
    };
    const base: ContainerConfig = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
      cliScope: 'disabled',
    };
    const plan = (ids: string[]): ContainerConfig['sessionRuntimePlan'] => ({
      runtime: { runtimeId: 'claude', runtimeStateKey: 'claude' },
      capabilities: ids.map((id) => ({ id, adapter: 'mcp' as const, entrypoint: `tool:${id}` })),
      rejectedCapabilities: [],
      policy: { cliScope: 'disabled', approvalMode: 'default', writableWorkspace: true },
      instructionSections: [],
    });
    const first = path.join(projectRoot, 'sessions', 'first', 'provider-docs');
    const second = path.join(projectRoot, 'sessions', 'second', 'provider-docs');

    composeGroupClaudeMd(group, {
      outputDir: first,
      containerConfig: { ...base, sessionRuntimePlan: plan(['nanoclaw.send-message']) },
    });
    composeGroupClaudeMd(group, {
      outputDir: second,
      containerConfig: { ...base, sessionRuntimePlan: plan(['nanoclaw.schedule-task']) },
    });

    expect(fs.lstatSync(path.join(first, '.claude-fragments', 'module-core.md')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(first, '.claude-fragments', 'module-scheduling.md'))).toBe(false);
    expect(fs.existsSync(path.join(second, '.claude-fragments', 'module-core.md'))).toBe(false);
    expect(fs.lstatSync(path.join(second, '.claude-fragments', 'module-scheduling.md')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, 'groups', group.folder, 'CLAUDE.md'))).toBe(false);
  });
});
