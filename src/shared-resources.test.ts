import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveHostPath } from './shared-resources.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-shared-path-'));
  roots.push(root);
  return root;
}

describe('resolveHostPath', () => {
  it('maps an /app/shared symlink to its host backing resource', () => {
    const root = tempRoot();
    const groupDir = path.join(root, 'groups', 'agent');
    const backing = path.join(root, 'groups', 'shared', 'trading-data', 'investments.db');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.dirname(backing), { recursive: true });
    fs.writeFileSync(backing, '');
    const link = path.join(groupDir, 'investments.db');
    fs.symlinkSync('/app/shared/trading-data/investments.db', link);

    expect(resolveHostPath(link, root)).toBe(backing);
  });

  it('leaves an ordinary host path unchanged', () => {
    const root = tempRoot();
    const file = path.join(root, 'groups', 'agent', 'investments.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');

    expect(resolveHostPath(file, root)).toBe(file);
  });

  it('rejects container targets that escape known mounted resources', () => {
    const root = tempRoot();
    const groupDir = path.join(root, 'groups', 'agent');
    fs.mkdirSync(groupDir, { recursive: true });
    const link = path.join(groupDir, 'investments.db');
    fs.symlinkSync('/etc/passwd', link);

    expect(() => resolveHostPath(link, root)).toThrow(/unsupported container-only symlink/);
  });
});
