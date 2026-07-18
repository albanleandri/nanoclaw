import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({ allowlistPath: '' }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../config.js');
  return {
    ...actual,
    get MOUNT_ALLOWLIST_PATH() {
      return mockState.allowlistPath;
    },
  };
});

import { loadMountAllowlist, validateMount } from './index.js';

let tmpDir: string;
let configFile: string;
let projectsDir: string;
let repoDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnt-sec-'));
  configFile = path.join(tmpDir, 'mount-allowlist.json');
  mockState.allowlistPath = configFile;
  projectsDir = path.join(tmpDir, 'projects');
  repoDir = path.join(projectsDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function writeAllowlist(value: unknown): void {
  fs.writeFileSync(configFile, `${JSON.stringify(value, null, 2)}\n`);
}

describe('mount allowlist loading', () => {
  it('translates readOnly:false into a read-write grant', () => {
    writeAllowlist({ allowedRoots: [{ path: projectsDir, readOnly: false }], blockedPatterns: [] });

    expect(loadMountAllowlist()?.allowedRoots[0].allowReadWrite).toBe(true);
    expect(validateMount({ hostPath: repoDir, readonly: false })).toMatchObject({
      allowed: true,
      effectiveReadonly: false,
    });
  });

  it('keeps readOnly:true fail-closed', () => {
    writeAllowlist({ allowedRoots: [{ path: projectsDir, readOnly: true }], blockedPatterns: [] });

    expect(validateMount({ hostPath: repoDir, readonly: false })).toMatchObject({
      allowed: true,
      effectiveReadonly: true,
    });
  });

  it('recovers immediately after a malformed file is fixed', () => {
    fs.writeFileSync(configFile, 'not valid json {');
    expect(loadMountAllowlist()).toBeNull();

    writeAllowlist({ allowedRoots: [{ path: projectsDir, allowReadWrite: true }], blockedPatterns: [] });
    expect(loadMountAllowlist()?.allowedRoots).toHaveLength(1);
  });
});
