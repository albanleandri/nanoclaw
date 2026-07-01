import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { approveSkill } from '../db/skill-provenance.js';
import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { collectSkillInstructionFragments } from '../instruction-sections.js';
import { discoverSkillCatalog } from './catalog.js';
import { resolveSkillRequirements } from './resolve-requirements.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-requirements-'));
  const directory = path.join(root, 'container', 'skills', 'research');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), 'research');
  fs.writeFileSync(path.join(directory, 'instructions.md'), 'research instructions');
  fs.writeFileSync(
    path.join(directory, 'skill.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'research',
      version: '1.0.0',
      source: { kind: 'local', id: 'local/research' },
      requiresCapabilities: ['memory.session-search'],
      optionalCapabilities: ['web.browse'],
      compatibleRuntimeIds: ['claude-sdk'],
    }),
  );
  const db = initTestDb();
  runMigrations(db);
});
afterEach(() => {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('skill requirement resolution', () => {
  it('quarantines before approval and emits requirements after approval', () => {
    expect(collectSkillInstructionFragments(root, ['research'])).toEqual([]);
    expect(() =>
      resolveSkillRequirements({ projectRoot: root, selection: ['research'], runtimeId: 'claude-sdk' }),
    ).toThrow(/quarantined/);
    approveSkill(discoverSkillCatalog(root).get('research')!, 'operator');
    expect(collectSkillInstructionFragments(root, ['research'])).toEqual([
      { name: 'research', containerPath: '/app/skills/research/instructions.md' },
    ]);
    expect(resolveSkillRequirements({ projectRoot: root, selection: ['research'], runtimeId: 'claude-sdk' })).toEqual({
      requiredCapabilities: ['memory.session-search'],
      optionalCapabilities: ['web.browse'],
      skippedSkills: [],
      effectiveSkills: ['research'],
    });
  });

  it('detects drift and runtime incompatibility', () => {
    approveSkill(discoverSkillCatalog(root).get('research')!, 'operator');
    fs.appendFileSync(path.join(root, 'container', 'skills', 'research', 'SKILL.md'), 'changed');
    expect(() =>
      resolveSkillRequirements({ projectRoot: root, selection: ['research'], runtimeId: 'claude-sdk' }),
    ).toThrow(/drifted/);
  });

  it.each(['claude-sdk', 'codex-app-server'])(
    'skips a removed configured skill without blocking %s startup',
    (runtimeId) => {
      expect(
        resolveSkillRequirements({
          projectRoot: root,
          selection: ['removed-skill'],
          runtimeId,
        }),
      ).toEqual({
        requiredCapabilities: [],
        optionalCapabilities: [],
        skippedSkills: ['removed-skill'],
        effectiveSkills: [],
      });
    },
  );
});
