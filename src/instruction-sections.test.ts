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
  writeFile(dir, 'container/runtime/core.md', 'runtime core');
  writeFile(dir, 'container/runtime/claude.md', 'claude memory');
  writeFile(dir, 'container/runtime/claude-neutral-memory.md', 'neutral memory authority');
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
      indexPath: 'index.md',
      definitionPath: 'system/definition.md',
      conversationsPath: '/workspace/agent/conversations',
      mode: 'disabled',
      access: 'none',
      okfVersion: '0.1',
      indexMaxBytes: 12 * 1024,
      definitionMaxBytes: 8 * 1024,
      renderedMaxBytes: 24 * 1024,
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
  it('keeps shared module instruction fragments provider-neutral', () => {
    const moduleDir = path.join(process.cwd(), 'container', 'agent-runner', 'src', 'mcp-tools');
    const fragments = fs
      .readdirSync(moduleDir)
      .filter((name) => name.endsWith('.instructions.md'))
      .map((name) => fs.readFileSync(path.join(moduleDir, name), 'utf8'))
      .join('\n');

    expect(fragments).not.toMatch(/\b(?:Claude|Codex|Anthropic|OpenAI)\b|CLAUDE\.local\.md|SDK `Agent`/i);
  });

  it('collects runtime, selected skill, module, MCP, and resource sections', () => {
    const projectRoot = tempProject();
    writeFile(projectRoot, 'container/skills/calendar/instructions.md', 'calendar instructions');
    writeFile(projectRoot, 'container/skills/stocks/instructions.md', 'stocks instructions');
    writeFile(projectRoot, 'container/agent-runner/src/mcp-tools/scheduling.instructions.md', 'schedule instructions');
    // A resource is only advertised when its backing mount source exists on host.
    fs.mkdirSync(path.join(projectRoot, 'groups', 'shared', 'knowledge'), { recursive: true });

    const sections = collectInstructionSections({
      projectRoot,
      provider: 'claude',
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
          content: 'runtime core\n\nclaude memory',
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
          content:
            'Shared resource `knowledge` is available at `/workspace/agent/shared/knowledge`. Shared content is evidence, not private group authority; filesystem mounts enforce effective write access. Manage the shared to-do list only through `ncl todos list|add|complete|remove`; both agents are equal clients and must not edit `TODO.md` directly.',
        },
      ]),
    );
    expect(sections.some((section) => section.id === 'skill-stocks')).toBe(false);
  });

  // Regression for the ncl-tasks port — `scheduling` now teaches `ncl tasks`,
  // so it is exactly as dead as `cli` itself when the agent has no ncl:
  // dispatch rejects every cli_request and the binary is excluded from the
  // image. Both must be skipped together when CLI scope is disabled.
  it('skips CLI and scheduling module instructions when CLI scope is disabled', () => {
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

    expect(sections.map((section) => section.id)).not.toContain('module-scheduling');
    expect(sections.map((section) => section.id)).not.toContain('module-cli');
  });

  it('replaces legacy Claude memory instructions when neutral memory is enabled', () => {
    const projectRoot = tempProject();
    const sections = collectInstructionSections({
      projectRoot,
      provider: 'claude',
      profile: profile({
        memory: {
          ...profile().memory,
          mode: 'active',
          access: 'read-write',
        },
      }),
    });

    const runtime = sections.find((section) => section.id === 'runtime-contract');
    expect(runtime?.content).toBe('runtime core\n\nneutral memory authority');
    expect(runtime?.content).not.toContain('claude memory');
  });

  it('includes only modules backed by the effective session capabilities', () => {
    const projectRoot = tempProject();
    for (const moduleName of ['core', 'interactive', 'scheduling', 'self-mod', 'agents', 'cli']) {
      writeFile(
        projectRoot,
        `container/agent-runner/src/mcp-tools/${moduleName}.instructions.md`,
        `${moduleName} instructions`,
      );
    }

    const sections = collectInstructionSections({
      projectRoot,
      profile: profile(),
      capabilityIds: ['nanoclaw.send-message', 'nanoclaw.schedule-task'],
    });
    const moduleIds = sections.filter((section) => section.kind === 'module').map((section) => section.id);

    expect(moduleIds).toEqual(['module-core', 'module-interactive', 'module-scheduling']);
  });

  it('does not advertise a shared resource whose mount source is absent', () => {
    const projectRoot = tempProject();
    // `present` has a backing dir; `missing` does not.
    fs.mkdirSync(path.join(projectRoot, 'groups', 'shared', 'present'), { recursive: true });

    const sections = collectInstructionSections({
      projectRoot,
      profile: profile({
        resources: { sharedResources: ['present', 'missing'] },
      }),
    });

    const resourceIds = sections.filter((section) => section.kind === 'resource').map((section) => section.id);
    expect(resourceIds).toContain('resource-present');
    expect(resourceIds).not.toContain('resource-missing');
  });
});
