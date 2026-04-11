import { describe, expect, it } from 'vitest';

import {
  formatRuntimeSelectionList,
  getAvailableSkillOptions,
  RECOMMENDED_SECONDARY_SKILLS,
  RECOMMENDED_SECONDARY_TOOLS,
  SELECTABLE_RUNTIME_TOOLS,
} from './runtime-capabilities.js';

describe('runtime capability defaults', () => {
  it('keeps the recommended secondary-group skill defaults', () => {
    expect(RECOMMENDED_SECONDARY_SKILLS).toEqual([
      'agent-browser',
      'capabilities',
      'status',
    ]);
  });

  it('keeps recommended secondary-group tools as a strict subset of selectable tools', () => {
    const selectableIds = new Set<string>(
      SELECTABLE_RUNTIME_TOOLS.map(([id]) => id),
    );
    for (const tool of RECOMMENDED_SECONDARY_TOOLS) {
      expect(selectableIds.has(tool)).toBe(true);
    }
  });
});

describe('getAvailableSkillOptions', () => {
  it('discovers skills from the first available root and marks recommended ones', () => {
    const fsLike = {
      existsSync: (target: string) =>
        target === '/skills' ||
        target === '/skills/agent-browser/SKILL.md' ||
        target === '/skills/custom-research/SKILL.md',
      readFileSync: (target: string) => {
        if (target === '/skills/agent-browser/SKILL.md') {
          return '# Agent Browser\n\nBrowse pages interactively.\n';
        }
        return '# Custom Research\n\nRun a custom research workflow.\n';
      },
      readdirSync: () => ['custom-research', 'agent-browser', 'agents'],
      statSync: () => ({ isDirectory: () => true }),
    };

    const skills = getAvailableSkillOptions(fsLike as never, ['/skills']);

    expect(skills).toEqual([
      {
        name: 'agent-browser',
        description: 'Browse pages interactively.',
        recommended: true,
      },
      {
        name: 'custom-research',
        description: 'Run a custom research workflow.',
        recommended: false,
      },
    ]);
  });

  it('returns an empty list when no skill roots are available', () => {
    const fsLike = {
      existsSync: () => false,
      readFileSync: () => '',
      readdirSync: () => [],
      statSync: () => ({ isDirectory: () => false }),
    };

    expect(getAvailableSkillOptions(fsLike as never, ['/missing'])).toEqual([]);
  });
});

describe('formatRuntimeSelectionList', () => {
  it('formats numbered tool and skill selections with recommendations', () => {
    const output = formatRuntimeSelectionList([
      {
        name: 'agent-browser',
        description: 'Browse pages interactively.',
        recommended: true,
      },
      {
        name: 'custom-research',
        description: 'Run a custom research workflow.',
        recommended: false,
      },
    ]);

    expect(output).toContain('Selectable runtime tools for a new secondary group:');
    expect(output).toContain('1. `Bash` - Run shell commands in the sandbox. [recommended]');
    expect(output).toContain('Selectable runtime skills for a new secondary group:');
    expect(output).toContain('1. `agent-browser` - Browse pages interactively. [recommended]');
    expect(output).toContain('2. `custom-research` - Run a custom research workflow.');
    expect(output).toContain('Recommended skill numbers for most secondary groups: 1');
    expect(output).toContain('tools: 1,2,3');
    expect(output).toContain('skills: 1,2,3');
  });

  it('shows a no-skills message when nothing is available', () => {
    const output = formatRuntimeSelectionList([]);
    expect(output).toContain('(No runtime skills were discovered in this install.)');
    expect(output).toContain('Recommended skill numbers for most secondary groups: (none)');
  });
});
