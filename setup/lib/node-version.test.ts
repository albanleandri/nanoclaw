import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const lib = join(dirname(fileURLToPath(import.meta.url)), 'node-version.sh');
const temporaryDirectories: string[] = [];

function run(script: string, env: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', `source "$1"; ${script}`, '_', lib], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function fakeNode(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'node');
  writeFileSync(path, `#!/bin/sh\necho v${version}\n`);
  chmodSync(path, 0o755);
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('node-version.sh', () => {
  it.each([
    ['22.23.4', true, '22'],
    ['v24.22.1', true, '24'],
    ['26.12.1', true, '26'],
    ['27.0.0', true, ''],
    ['22.23.3', false, '22'],
    ['24.22.0', false, '24'],
    ['26.2.5', false, '26'],
    ['20.19.5', false, '22'],
    ['25.3.0', false, ''],
    ['v27.0.0-nightly20261018', false, ''],
  ])('%s: minimum=%s install-line=%s', (version, meets, installLine) => {
    const checked = spawnSync(
      'bash',
      [
        '-c',
        'source "$1"; node_meets_minimum "$2" && printf yes || printf no; printf "|"; node_install_line "$2" || :',
        '_',
        lib,
        version,
      ],
      { encoding: 'utf8' },
    );
    expect(checked.status).toBe(0);
    expect(checked.stdout.trim()).toBe(`${meets ? 'yes' : 'no'}|${installLine}`);
  });

  it('reports the minimum for each supported release line', () => {
    const result = run('node_line_minimum 22; node_line_minimum 24; node_line_minimum 26');
    expect(result.stdout.trim().split('\n')).toEqual(['22.23.4', '24.22.1', '26.12.1']);
  });

  it('identifies only configured apt locations as apt-managed', () => {
    const result = run(
      'node_from_apt /test/apt/node && echo apt; node_from_apt /version-manager/node || echo external',
      { NODE_APT_DIRS: '/test/apt' },
    );
    expect(result.stdout.trim().split('\n')).toEqual(['apt', 'external']);
  });

  it('selects a patched off-PATH Node when the current one is vulnerable', () => {
    const root = mkdtempSync(join(tmpdir(), 'ncl-node-version-'));
    temporaryDirectories.push(root);
    const old = join(root, 'old');
    const patched = join(root, 'patched');
    fakeNode(old, '22.23.3');
    fakeNode(patched, '22.23.4');

    const result = run('node_use_patched; command -v node; node --version', {
      HOME: join(root, 'home'),
      PATH: `${old}:/usr/bin:/bin`,
      NODE_APT_DIRS: patched,
      NODE_SYSTEM_DIRS: patched,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([join(patched, 'node'), 'v22.23.4']);
  });

  it('formats an actionable minimum message', () => {
    const result = run('node_minimum_message v22.20.0 /opt/node');
    expect(result.stdout.trim()).toBe(
      'Node v22.20.0 at /opt/node does not meet the minimum (22.23.4 / 24.22.1 / 26.12.1).',
    );
  });
});
