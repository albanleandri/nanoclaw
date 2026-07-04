import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hardenProjectSecretFiles, writePrivateFileSync } from './private-files.js';

describe('private files', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-private-files-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes new and existing files with owner-only permissions', () => {
    const file = path.join(root, '.env');
    fs.writeFileSync(file, 'OLD=value\n', { mode: 0o664 });

    writePrivateFileSync(file, 'SECRET=value\n');

    expect(fs.readFileSync(file, 'utf8')).toBe('SECRET=value\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses to write through a private-file symlink', () => {
    const target = path.join(root, 'target');
    const link = path.join(root, '.env');
    fs.writeFileSync(target, 'unchanged\n');
    fs.symlinkSync(target, link);

    expect(() => writePrivateFileSync(link, 'SECRET=value\n')).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('unchanged\n');
  });

  it('hardens existing secrets and removes the obsolete environment mirror', () => {
    const envFile = path.join(root, '.env');
    const mirror = path.join(root, 'data', 'env', 'env');
    const snapshot = path.join(root, 'groups', 'main', 'container.json');
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    fs.writeFileSync(envFile, 'SECRET=value\n', { mode: 0o664 });
    fs.writeFileSync(mirror, 'SECRET=value\n', { mode: 0o664 });
    fs.writeFileSync(snapshot, '{"env":{"SECRET":"value"}}\n', { mode: 0o664 });

    hardenProjectSecretFiles(root);

    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(mirror)).toBe(false);
    expect(fs.statSync(snapshot).mode & 0o777).toBe(0o600);
  });
});
