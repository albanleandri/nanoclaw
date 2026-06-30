import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { hashSkillDirectory } from './hash.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('skill directory hash', () => {
  it('is deterministic and changes with content, name, and executable mode', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-hash-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'SKILL.md'), 'one');
    const first = hashSkillDirectory(root);
    expect(hashSkillDirectory(root)).toBe(first);
    fs.writeFileSync(path.join(root, 'SKILL.md'), 'two');
    const second = hashSkillDirectory(root);
    expect(second).not.toBe(first);
    fs.renameSync(path.join(root, 'SKILL.md'), path.join(root, 'instructions.md'));
    expect(hashSkillDirectory(root)).not.toBe(second);
    fs.chmodSync(path.join(root, 'instructions.md'), 0o755);
    expect(hashSkillDirectory(root)).not.toBe(hashSkillDirectoryAfterModeReset(root));
  });

  it('rejects symlinks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-hash-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'SKILL.md'), 'one');
    fs.symlinkSync(path.join(root, 'SKILL.md'), path.join(root, 'link'));
    expect(() => hashSkillDirectory(root)).toThrow(/Unsafe/);
  });
});

function hashSkillDirectoryAfterModeReset(root: string): string {
  fs.chmodSync(path.join(root, 'instructions.md'), 0o644);
  return hashSkillDirectory(root);
}
