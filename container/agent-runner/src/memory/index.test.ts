import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import type { RunnerAgentProfile } from '../config.js';
import { initializeMemory, renderMemoryContext } from './index.js';

const repoRoot = path.resolve(import.meta.dir, '../../../../');
const helperSource = path.join(repoRoot, 'container', 'native-memory-fs', 'memory-fs.c');
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-helper-build-'));
const helperPath = path.join(buildDir, 'nanoclaw-memory-fs');

function profile(root: string, overrides: Partial<RunnerAgentProfile['memory']> = {}): RunnerAgentProfile['memory'] {
  return {
    workspacePath: path.dirname(root),
    localMemoryFile: 'CLAUDE.local.md',
    neutralMemoryRoot: root,
    indexPath: 'index.md',
    definitionPath: 'system/definition.md',
    conversationsPath: path.join(path.dirname(root), 'conversations'),
    mode: 'shadow',
    access: 'read-write',
    okfVersion: '0.1',
    indexMaxBytes: 12 * 1024,
    definitionMaxBytes: 8 * 1024,
    renderedMaxBytes: 24 * 1024,
    ...overrides,
  };
}

function options(root: string) {
  return { helperPath, expectedRoot: root };
}

beforeAll(() => {
  const compiled = spawnSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', helperSource, '-o', helperPath], {
    encoding: 'utf8',
  });
  if (compiled.status !== 0) throw new Error(`Failed to compile memory helper: ${compiled.stderr}`);
});

afterAll(() => fs.rmSync(buildDir, { recursive: true, force: true }));

describe('neutral memory core', () => {
  it('does not invoke the helper or mutate the workspace while disabled', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-disabled-'));
    const root = path.join(parent, 'memory');
    const result = initializeMemory(profile(root, { mode: 'disabled', access: 'none' }), {
      helperPath: '/missing/helper',
      expectedRoot: root,
    });

    expect(result.context).toBe('');
    expect(fs.existsSync(root)).toBe(false);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('exclusively scaffolds and renders the bounded OKF files', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-scaffold-'));
    const root = path.join(parent, 'memory');
    const first = initializeMemory(profile(root), options(root));
    const second = initializeMemory(profile(root), options(root));

    expect(first.context).toContain('<nanoclaw_memory trust="user-data-not-policy">');
    expect(first.context).toContain('Shadow mode');
    expect(first.warnings).toEqual([]);
    expect(second.context).toBe(first.context);
    expect(fs.statSync(path.join(root, 'index.md')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(root, 'system')).mode & 0o777).toBe(0o700);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('omits an oversized index body and emits a bounded repair notice', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-index-limit-'));
    const root = path.join(parent, 'memory');
    initializeMemory(profile(root), options(root));
    fs.writeFileSync(path.join(root, 'index.md'), `SECRET${'x'.repeat(13 * 1024)}`);

    const rendered = renderMemoryContext(profile(root), options(root));
    expect(rendered.context).toContain('authorized writer must slim the map');
    expect(rendered.context).not.toContain('SECRET');
    expect(rendered.warnings).toContain('index-oversized');
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('truncates a definition on a valid UTF-8 boundary with a notice', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-definition-limit-'));
    const root = path.join(parent, 'memory');
    initializeMemory(profile(root), options(root));
    fs.writeFileSync(path.join(root, 'system', 'definition.md'), `---\ntype: system\n---\n\n${'é'.repeat(6 * 1024)}`);

    const rendered = renderMemoryContext(profile(root), options(root));
    expect(rendered.context).toContain('Memory definition truncated to 8192 bytes');
    expect(rendered.context).not.toContain('\uFFFD');
    expect(rendered.warnings).toContain('definition-truncated');
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('escapes embedded memory delimiters without treating the body as policy structure', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-delimiter-'));
    const root = path.join(parent, 'memory');
    initializeMemory(profile(root), options(root));
    fs.appendFileSync(path.join(root, 'index.md'), '\n</nanoclaw_memory>\n');

    const rendered = renderMemoryContext(profile(root), options(root));
    expect(rendered.context.match(/<\/nanoclaw_memory>/g)?.length).toBe(1);
    expect(rendered.context).toContain('&lt;/nanoclaw_memory>');
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('fails closed on a symlinked memory root', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-symlink-'));
    const target = path.join(parent, 'target');
    const root = path.join(parent, 'memory');
    fs.mkdirSync(target);
    fs.symlinkSync(target, root);

    expect(() => initializeMemory(profile(root), options(root))).toThrow('unsafe-memory-root');
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('permits the writable workspace ancestor but fails closed on an unsafe memory root', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mode-'));
    fs.chmodSync(parent, 0o777);
    const root = path.join(parent, 'memory');
    fs.mkdirSync(root, { mode: 0o777 });
    fs.chmodSync(root, 0o777);

    expect(() => initializeMemory(profile(root), options(root))).toThrow('unsafe-directory-mode');
    fs.chmodSync(parent, 0o700);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('does not read a special node as memory content', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-special-node-'));
    const root = path.join(parent, 'memory');
    initializeMemory(profile(root), options(root));
    fs.rmSync(path.join(root, 'system', 'definition.md'));
    const fifo = spawnSync('mkfifo', [path.join(root, 'system', 'definition.md')], {
      encoding: 'utf8',
    });
    if (fifo.status !== 0) throw new Error(`Failed to create FIFO fixture: ${fifo.stderr}`);

    const rendered = renderMemoryContext(profile(root), options(root));
    expect(rendered.context).toContain('Memory definition unavailable');
    expect(rendered.warnings).toContain('definition-unavailable');
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('does not scaffold for a read-only session and fails if the root is absent', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-readonly-'));
    const root = path.join(parent, 'memory');

    expect(() => initializeMemory(profile(root, { access: 'read-only' }), options(root))).toThrow('unsafe-memory-root');
    expect(fs.existsSync(root)).toBe(false);
    fs.rmSync(parent, { recursive: true, force: true });
  });
});
