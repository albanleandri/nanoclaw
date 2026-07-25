import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { validateMemoryTree } from './validator.js';

const repoRoot = path.resolve(import.meta.dir, '../../../../');
const helperSource = path.join(repoRoot, 'container', 'native-memory-fs', 'memory-fs.c');
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-validator-helper-'));
const helperPath = path.join(buildDir, 'nanoclaw-memory-fs');
const roots: string[] = [];

function tempRoot(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-validator-'));
  fs.chmodSync(parent, 0o700);
  roots.push(parent);
  return path.join(parent, 'memory');
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, content, { mode: 0o600 });
}

beforeAll(() => {
  const compiled = spawnSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', helperSource, '-o', helperPath], {
    encoding: 'utf8',
  });
  if (compiled.status !== 0) throw new Error(`Failed to compile memory helper: ${compiled.stderr}`);
});

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(buildDir, { recursive: true, force: true });
});

describe('thin memory validator', () => {
  it('accepts a complete reachable OKF scaffold without returning bodies', () => {
    const root = tempRoot();
    write(
      root,
      'index.md',
      '---\nokf_version: "0.1"\n---\n\n- [System](system/index.md)\n- [Person](people/alex.md)\n',
    );
    write(root, 'system/index.md', '---\ntype: system\n---\n\n- [Definition](definition.md)\n');
    write(root, 'system/definition.md', '---\ntype: system\n---\n\nSECRET_DEFINITION\n');
    write(root, 'people/alex.md', '---\ntype: person\n---\n\nSECRET_PERSON\n');

    const report = validateMemoryTree(root, { helperPath });

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('classifies hostile nodes, links, types, duplicates, reachability, and budgets with redacted output', () => {
    const root = tempRoot();
    write(
      root,
      'index.md',
      `---\nokf_version: "9.9"\n---\n\n- [Absolute](/secret)\n- [Escape](../outside.md)\n- [Broken](missing.md)\n${'x'.repeat(13 * 1024)}`,
    );
    write(root, 'system/index.md', '---\ntype: [bad]\n---\n');
    write(root, 'system/definition.md', `---\ntype: system\n---\n${'y'.repeat(9 * 1024)}`);
    write(root, 'orphan.md', 'SECRET_ORPHAN');
    write(root, 'Case.md', '---\ntype: note\n---\n');
    write(root, 'case.md', '---\ntype: note\n---\n');
    fs.symlinkSync('index.md', path.join(root, 'linked.md'));
    const fifo = spawnSync('mkfifo', [path.join(root, 'special')], { encoding: 'utf8' });
    if (fifo.status !== 0) throw new Error(`Failed to create FIFO: ${fifo.stderr}`);

    const report = validateMemoryTree(root, { helperPath });
    const classifications = new Set(report.findings.map((finding) => finding.classification));

    for (const expected of [
      'unsupported-version',
      'malformed-type',
      'missing-type',
      'symlink',
      'unsafe-node',
      'absolute-link',
      'escaping-link',
      'broken-link',
      'unreachable-concept',
      'duplicate-normalized-path',
      'oversized-always-loaded',
    ]) {
      expect(classifications.has(expected as never)).toBe(true);
    }
    expect(report.findings.length).toBeLessThanOrEqual(256);
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });
});
