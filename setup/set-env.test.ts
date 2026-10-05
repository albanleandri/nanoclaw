// Regression for the set-env bugs fixed alongside upstream 1100f83f: a value
// containing `$&` was mangled by String.replace, a newline in a value could
// inject further keys, and the write truncated .env in place.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./status.js', () => ({ emitStatus: vi.fn() }));

import { run } from './set-env.js';

let dir: string;
let prevCwd: string;

beforeEach(() => {
  prevCwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-env-'));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(dir, { recursive: true, force: true });
});

const env = () => fs.readFileSync(path.join(dir, '.env'), 'utf-8');

describe('set-env', () => {
  it('keeps $-sequences in a replaced value literal', async () => {
    fs.writeFileSync(path.join(dir, '.env'), 'A=1\nTOKEN=old\nB=2\n');
    await run(['--key', 'TOKEN', '--value', "x$&y$'z$1"]);
    expect(env()).toBe("A=1\nTOKEN=x$&y$'z$1\nB=2\n");
  });

  it('refuses a value that would inject another key', async () => {
    fs.writeFileSync(path.join(dir, '.env'), 'A=1\n');
    await expect(run(['--key', 'TOKEN', '--value', 'abc\nADMIN=1'])).rejects.toThrow(/single line/);
    expect(env()).toBe('A=1\n');
  });

  it('writes an owner-only file and leaves no temp file behind', async () => {
    await run(['--key', 'TOKEN', '--value', 'v']);
    expect(env()).toBe('TOKEN=v\n');
    expect(fs.statSync(path.join(dir, '.env')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['.env']);
  });

  it('refuses to write through a symlinked .env', async () => {
    fs.writeFileSync(path.join(dir, 'target'), 'A=1\n');
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, '.env'));
    await expect(run(['--key', 'TOKEN', '--value', 'v'])).rejects.toThrow(/not a regular file/);
    expect(fs.readFileSync(path.join(dir, 'target'), 'utf-8')).toBe('A=1\n');
  });
});
