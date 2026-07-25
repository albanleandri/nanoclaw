import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildMemoryValidatorContainerArgs, selectSharedMemoryRoot } from './memory-operator.js';

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('memory validator operator container', () => {
  it('uses an isolated read-only launch with only workspace and reviewed source mounts', () => {
    const args = buildMemoryValidatorContainerArgs(
      '/groups/example',
      '/repo/container/agent-runner/src',
      'image:test',
      1234,
      5678,
    );

    expect(args).toEqual([
      'run',
      '--rm',
      '--user',
      '1234:5678',
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=16m',
      '--mount',
      'type=bind,src=/groups/example,dst=/workspace/agent,readonly',
      '--mount',
      'type=bind,src=/repo/container/agent-runner/src,dst=/app/src,readonly',
      '--entrypoint',
      'bun',
      'image:test',
      '/app/src/memory/validator-cli.ts',
      '/workspace/agent/memory',
    ]);
    expect(args).not.toContain('/var/run/docker.sock');
  });

  it('selects a safe nested knowledge root without following a symlink', () => {
    const resource = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-okf-root-'));
    temporary.push(resource);
    fs.mkdirSync(path.join(resource, 'knowledge'));
    fs.writeFileSync(path.join(resource, 'knowledge', 'index.md'), '# index\n');
    expect(selectSharedMemoryRoot(resource)).toBe('knowledge');

    fs.rmSync(path.join(resource, 'knowledge'), { recursive: true });
    fs.symlinkSync('/tmp', path.join(resource, 'knowledge'));
    expect(() => selectSharedMemoryRoot(resource)).toThrow('Shared OKF root must be a real directory');
  });
});
