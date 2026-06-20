import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeGroupClaudeMd } from './claude-md-compose.js';
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

    expect(fs.readlinkSync(path.join(groupDir, '.claude-shared.md'))).toBe('/app/CLAUDE.md');
    expect(fs.readlinkSync(path.join(groupDir, '.claude-fragments', 'skill-calendar.md'))).toBe(
      '/app/skills/calendar/instructions.md',
    );
    expect(fs.readlinkSync(path.join(groupDir, '.claude-fragments', 'module-scheduling.md'))).toBe(
      '/app/src/mcp-tools/scheduling.instructions.md',
    );
    expect(fs.readFileSync(path.join(groupDir, '.claude-fragments', 'mcp-search.md'), 'utf-8')).toBe('search tools');
    expect(fs.existsSync(path.join(groupDir, '.claude-fragments', 'stale.md'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(true);

    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8')).toBe(
      [
        '<!-- Composed at spawn — do not edit. Edit CLAUDE.local.md for per-group content. -->',
        '@./.claude-shared.md',
        '@./.claude-fragments/mcp-search.md',
        '@./.claude-fragments/module-scheduling.md',
        '@./.claude-fragments/skill-calendar.md',
        '',
      ].join('\n'),
    );
  });
});
