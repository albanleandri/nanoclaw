import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { collectSkillInstructionFragments } from './claude-md-compose.js';

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-compose-'));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(projectRoot: string, skillPath: string): void {
  const dir = path.join(projectRoot, 'container', 'skills', skillPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'instructions.md'), `${skillPath}\n`);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('collectSkillInstructionFragments', () => {
  it('returns only selected skill instruction fragments', () => {
    const projectRoot = tempProject();
    writeSkill(projectRoot, 'welcome');
    writeSkill(projectRoot, 'agent-browser');

    expect(collectSkillInstructionFragments(projectRoot, ['welcome'])).toEqual([
      {
        name: 'welcome',
        containerPath: '/app/skills/welcome/instructions.md',
      },
    ]);
  });

  it('returns all available fragments when skills selection is all', () => {
    const projectRoot = tempProject();
    writeSkill(projectRoot, 'welcome');
    writeSkill(projectRoot, 'agent-browser');

    expect(collectSkillInstructionFragments(projectRoot, 'all')).toEqual([
      {
        name: 'agent-browser',
        containerPath: '/app/skills/agent-browser/instructions.md',
      },
      {
        name: 'welcome',
        containerPath: '/app/skills/welcome/instructions.md',
      },
    ]);
  });

  it('lets custom skills override built-in fragments by name', () => {
    const projectRoot = tempProject();
    writeSkill(projectRoot, 'welcome');
    writeSkill(projectRoot, 'custom/welcome');

    expect(collectSkillInstructionFragments(projectRoot, ['welcome'])).toEqual([
      {
        name: 'welcome',
        containerPath: '/app/skills/custom/welcome/instructions.md',
      },
    ]);
  });
});
