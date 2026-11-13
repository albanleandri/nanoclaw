import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(join(here, 'Dockerfile'), 'utf8');
const nodeVersionLib = join(here, '..', 'setup', 'lib', 'node-version.sh');

describe('container/Dockerfile runtime baseline', () => {
  const from = dockerfile.match(/^FROM node:(\S+)$/m);

  it('pins an exact Node release by digest', () => {
    expect(from?.[1]).toMatch(/^\d+\.\d+\.\d+-slim@sha256:[0-9a-f]{64}$/);
  });

  it('meets the setup Node minimum', () => {
    const version = from?.[1].split('-')[0] ?? '';
    const result = spawnSync('bash', ['-c', 'source "$1"; node_meets_minimum "$2"', '_', nodeVersionLib, version]);
    expect(result.status).toBe(0);
  });

  it('pins and verifies Bun and pins the package managers', () => {
    expect(dockerfile).toContain('ARG BUN_VERSION=1.4.4');
    expect(dockerfile).toContain('test "$(bun --version)" = "${BUN_VERSION}"');
    expect(dockerfile).toContain('ARG PNPM_VERSION=10.34.9');
    expect(dockerfile).toContain('ARG NPM_VERSION=11.21.2');
  });
});
