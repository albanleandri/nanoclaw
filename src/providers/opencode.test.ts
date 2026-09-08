import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const tempRoots: string[] = [];

afterEach(() => {
  vi.resetModules();
  for (const tmp of tempRoots.splice(0)) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('opencode provider container config', () => {
  it('places every OpenCode XDG root in a writable per-session mount', async () => {
    vi.resetModules();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-opencode-provider-'));
    tempRoots.push(tmp);
    const sessionDir = path.join(tmp, 'session');

    const registry = await import('./provider-container-registry.js');
    await import('./opencode.js');
    const getContribution = registry.getProviderContainerConfig('opencode');
    if (!getContribution) throw new Error('opencode provider container config was not registered');

    const contribution = getContribution({
      sessionDir,
      agentGroupId: 'ag-opencode',
      groupDir: path.join(tmp, 'group'),
      selectedSkills: [],
      hostEnv: {
        OPENCODE_PROVIDER: 'proton-lumo',
        OPENCODE_PROVIDER_NPM: '@ai-sdk/openai-compatible',
        OPENCODE_MODEL: 'proton-lumo/lumo-max',
        ANTHROPIC_BASE_URL: 'https://lumo.proton.me/api/ai/v1',
      },
    });
    const mountRoot = path.join(sessionDir, 'opencode-xdg');

    expect(contribution.mounts).toEqual([{ hostPath: mountRoot, containerPath: '/opencode-xdg', readonly: false }]);
    expect(contribution.env).toMatchObject({
      XDG_DATA_HOME: '/opencode-xdg/data',
      XDG_STATE_HOME: '/opencode-xdg/state',
      XDG_CONFIG_HOME: '/opencode-xdg/config',
      XDG_CACHE_HOME: '/opencode-xdg/cache',
      OPENCODE_PROVIDER: 'proton-lumo',
      OPENCODE_PROVIDER_NPM: '@ai-sdk/openai-compatible',
      OPENCODE_MODEL: 'proton-lumo/lumo-max',
      ANTHROPIC_BASE_URL: 'https://lumo.proton.me/api/ai/v1',
    });
    for (const child of ['', 'data', 'state', 'config', 'cache']) {
      const target = path.join(mountRoot, child);
      expect(fs.statSync(target).isDirectory()).toBe(true);
      expect(fs.statSync(target).mode & 0o777).toBe(0o777);
    }
  });
});
