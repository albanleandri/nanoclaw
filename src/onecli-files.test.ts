import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stageOneCliFile } from './onecli-files.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-onecli-files-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('persistent OneCLI files', () => {
  it('reuses content-addressed paths with the required modes', () => {
    const ca = stageOneCliFile(dir, 'ca', 'CA');
    const stub = stageOneCliFile(dir, 'stub', 'secret');

    expect(stageOneCliFile(dir, 'ca', 'CA')).toBe(ca);
    expect(fs.readFileSync(ca, 'utf8')).toBe('CA');
    expect(fs.statSync(path.join(dir, 'onecli')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(ca).mode & 0o777).toBe(0o644);
    expect(fs.statSync(stub).mode & 0o777).toBe(0o600);
  });

  it.each(['directory', 'symlink'] as const)('refuses an existing %s collision', (collision) => {
    const file = stageOneCliFile(dir, 'ca', 'CA');
    const unrelated = path.join(dir, 'keep');
    fs.writeFileSync(unrelated, 'keep');
    fs.unlinkSync(file);
    if (collision === 'directory') fs.mkdirSync(file);
    else fs.symlinkSync(unrelated, file);

    const before = fs.lstatSync(file);
    expect(() => stageOneCliFile(dir, 'ca', 'CA')).toThrow(/OneCLI staged file/);
    expect(fs.lstatSync(file).ino).toBe(before.ino);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('keep');
  });

  it.each(['content', 'permissions'] as const)('repairs an owned regular file with mismatched %s', (mismatch) => {
    const file = stageOneCliFile(dir, 'ca', 'CA');
    const before = fs.lstatSync(file).ino;
    if (mismatch === 'content') fs.writeFileSync(file, 'wrong');
    else fs.chmodSync(file, 0o600);

    expect(stageOneCliFile(dir, 'ca', 'CA')).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('CA');
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    expect(fs.lstatSync(file).ino).not.toBe(before);
  });

  it.each(['symlink', 'permissions'] as const)('refuses an unsafe staging directory: %s', (kind) => {
    const directory = path.join(dir, 'onecli');
    if (kind === 'symlink') fs.symlinkSync(dir, directory);
    else fs.mkdirSync(directory, { mode: 0o755 });
    expect(() => stageOneCliFile(dir, 'ca', 'CA')).toThrow(/OneCLI file directory/);
  });

  it('removes only its unpublished temporary file after a failed write', () => {
    fs.mkdirSync(path.join(dir, 'onecli'), { mode: 0o700 });
    const unrelated = path.join(dir, 'onecli', '.pending-unrelated');
    fs.writeFileSync(unrelated, 'keep');
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('full'), { code: 'ENOSPC' });
    });
    expect(() => stageOneCliFile(dir, 'stub', 'sensitive')).toThrow('full');
    expect(fs.readdirSync(path.join(dir, 'onecli'))).toEqual(['.pending-unrelated']);
  });

  it('preserves the primary publish error when temporary cleanup also fails', () => {
    fs.mkdirSync(path.join(dir, 'onecli'), { mode: 0o700 });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('primary write failure'), { code: 'ENOSPC' });
    });
    vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw Object.assign(new Error('cleanup failure'), { code: 'EIO' });
    });

    expect(() => stageOneCliFile(dir, 'stub', 'sensitive')).toThrow('primary write failure');
  });
});
