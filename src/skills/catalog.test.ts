import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { discoverSkillCatalog } from './catalog.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function skill(root: string, relative: string, text: string): void {
  const directory = path.join(root, 'container', 'skills', relative);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), text);
}

describe('skill catalog', () => {
  it('uses custom override semantics and ignores dot directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-catalog-'));
    roots.push(root);
    skill(root, 'demo', 'builtin');
    skill(root, 'custom/demo', 'custom');
    skill(root, '.drafts/hidden', 'hidden');
    const catalog = discoverSkillCatalog(root);
    expect(catalog.get('demo')?.sourceRoot).toBe('custom');
    expect(fs.readFileSync(path.join(catalog.get('demo')!.directory, 'SKILL.md'), 'utf8')).toBe('custom');
    expect(catalog.has('hidden')).toBe(false);
  });
});
