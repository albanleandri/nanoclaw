import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentProfile } from './agent-profile.js';
import { collectInstructionSections } from './instruction-sections.js';

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-instruction-sections-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(projectRoot: string, relativePath: string, content: string): void {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    agentGroupId: 'ag-1',
    groupName: 'Research',
    assistantName: 'Research',
    memory: {
      workspacePath: '/workspace/agent',
      localMemoryFile: 'CLAUDE.local.md',
      neutralMemoryRoot: '/workspace/agent/memory',
    },
    tools: {
      skills: 'all',
      mcpServers: {},
      cliScope: 'group',
    },
    resources: {
      sharedResources: [],
    },
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('collectInstructionSections', () => {
  it('collects runtime, selected skill, module, MCP, and resource sections', () => {
    const projectRoot = tempProject();
    writeFile(projectRoot, 'container/skills/calendar/instructions.md', 'calendar instructions');
    writeFile(projectRoot, 'container/skills/stocks/instructions.md', 'stocks instructions');
    writeFile(projectRoot, 'container/agent-runner/src/mcp-tools/scheduling.instructions.md', 'schedule instructions');

    const sections = collectInstructionSections({
      projectRoot,
      profile: profile({
        tools: {
          skills: ['calendar'],
          cliScope: 'group',
          mcpServers: {
            search: {
              command: 'node',
              args: ['search.js'],
              env: {},
              instructions: 'search instructions',
            },
          },
        },
        resources: {
          sharedResources: ['knowledge'],
        },
      }),
    });

    expect(sections).toEqual(
      expect.arrayContaining([
        {
          id: 'runtime-contract',
          title: 'NanoClaw Runtime Contract',
          kind: 'runtime',
          containerPath: '/app/CLAUDE.md',
          required: true,
        },
        {
          id: 'skill-calendar',
          title: 'Skill: calendar',
          kind: 'skill',
          containerPath: '/app/skills/calendar/instructions.md',
        },
        {
          id: 'module-scheduling',
          title: 'NanoClaw Module: scheduling',
          kind: 'module',
          containerPath: '/app/src/mcp-tools/scheduling.instructions.md',
        },
        {
          id: 'mcp-search',
          title: 'MCP Server: search',
          kind: 'mcp',
          content: 'search instructions',
        },
        {
          id: 'resource-knowledge',
          title: 'Shared Resource: knowledge',
          kind: 'resource',
          content: 'Shared resource `knowledge` is available at `/workspace/agent/shared/knowledge`.',
        },
      ]),
    );
    expect(sections.some((section) => section.id === 'skill-stocks')).toBe(false);
  });

  it('skips CLI module instructions when CLI scope is disabled', () => {
    const projectRoot = tempProject();
    writeFile(projectRoot, 'container/agent-runner/src/mcp-tools/cli.instructions.md', 'cli instructions');
    writeFile(projectRoot, 'container/agent-runner/src/mcp-tools/scheduling.instructions.md', 'schedule instructions');

    const sections = collectInstructionSections({
      projectRoot,
      profile: profile({
        tools: {
          skills: 'all',
          mcpServers: {},
          cliScope: 'disabled',
        },
      }),
    });

    expect(sections.map((section) => section.id)).toContain('module-scheduling');
    expect(sections.map((section) => section.id)).not.toContain('module-cli');
  });
});
