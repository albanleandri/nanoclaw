import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverSkillCatalog } from '../skills/catalog.js';
import { closeDb, initTestDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import { approveSkill, getSkillInstallation, observeSkill, setSkillState } from './skill-provenance.js';

let root: string;

function writeSkill(body: string): void {
  const directory = path.join(root, 'container', 'skills', 'research');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), body);
  fs.writeFileSync(
    path.join(directory, 'skill.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'research',
      version: '1.0.0',
      source: { kind: 'local', id: 'local/research' },
      requiresCapabilities: ['memory.session-search'],
    }),
  );
}

function entry() {
  return discoverSkillCatalog(root).get('research')!;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-provenance-'));
  writeSkill('original');
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('skill provenance', () => {
  it('quarantines new content, approves one hash, detects drift, and permits rollback', () => {
    expect(observeSkill(entry())).toMatchObject({ state: 'quarantined', approved_hash: null });
    const approved = approveSkill(entry(), 'operator');
    expect(approved).toMatchObject({ state: 'active', approved_hash: approved.observed_hash });

    writeSkill('changed');
    expect(observeSkill(entry())).toMatchObject({ state: 'drifted', approved_hash: approved.approved_hash });

    writeSkill('original');
    expect(observeSkill(entry())).toMatchObject({ state: 'active', approved_hash: approved.approved_hash });
  });

  it('preserves an explicit disabled state across observations', () => {
    approveSkill(entry(), 'operator');
    setSkillState('research', 'disabled', 'operator');
    expect(observeSkill(entry())).toMatchObject({ state: 'disabled' });
    expect(getSkillInstallation('research')?.approved_by).toBe('operator');
  });

  it('re-hashes immediately before approval', () => {
    const stale = entry();
    writeSkill('changed after catalog read');
    expect(() => approveSkill(stale, 'operator')).toThrow(/changed during approval/);
  });
});
