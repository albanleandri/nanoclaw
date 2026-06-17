import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalHome = process.env.HOME;
const tempRoots: string[] = [];

interface LoadedCodexProvider {
  tmp: string;
  home: string;
  dataDir: string;
  groupDir: string;
  getContribution: NonNullable<
    Awaited<typeof import('./provider-container-registry.js')>['getProviderContainerConfig'] extends (
      name: string,
    ) => infer R
      ? R
      : never
  >;
}

async function loadCodexProvider(opts: { chatGptAuthMode?: string; hostAuth?: object }): Promise<LoadedCodexProvider> {
  vi.resetModules();
  vi.doMock('../db/agent-groups.js', () => ({ getAgentGroup: () => undefined }));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-provider-'));
  tempRoots.push(tmp);
  const home = path.join(tmp, 'home');
  const dataDir = path.join(tmp, 'data');
  const groupDir = path.join(tmp, 'groups', 'codex');
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  if (opts.hostAuth) {
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify(opts.hostAuth));
  }

  process.env.HOME = home;
  vi.doMock('../config.js', () => ({
    CODEX_CHATGPT_AUTH: opts.chatGptAuthMode ?? '',
    DATA_DIR: dataDir,
  }));

  const registry = await import('./provider-container-registry.js');
  await import('./codex.js');
  const getContribution = registry.getProviderContainerConfig('codex');
  if (!getContribution) throw new Error('codex provider container config was not registered');

  return { tmp, home, dataDir, groupDir, getContribution };
}

function runContribution(loaded: LoadedCodexProvider): ReturnType<LoadedCodexProvider['getContribution']> {
  return loaded.getContribution({
    sessionDir: path.join(loaded.dataDir, 'v2-sessions', 'sess-test'),
    agentGroupId: 'ag-codex',
    groupDir: loaded.groupDir,
    selectedSkills: [],
    hostEnv: {},
  });
}

afterEach(() => {
  process.env.HOME = originalHome;
  vi.resetModules();
  vi.doUnmock('../config.js');
  vi.doUnmock('../db/agent-groups.js');
  for (const tmp of tempRoots.splice(0)) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('codex provider container config', () => {
  it('creates the per-group Codex auth mount and sentinel auth file without ChatGPT opt-in', async () => {
    const loaded = await loadCodexProvider({});

    const contribution = runContribution(loaded);
    const codexDir = path.join(loaded.dataDir, 'v2-sessions', 'ag-codex', '.codex-shared');
    const authPath = path.join(codexDir, 'auth.json');

    expect(fs.existsSync(authPath)).toBe(true);
    expect(fs.readFileSync(authPath, 'utf-8')).toBe('');
    expect(contribution.mounts).toContainEqual({
      hostPath: codexDir,
      containerPath: '/home/node/.codex',
      readonly: false,
    });
  });

  it('copies a valid host ChatGPT Codex auth file into the per-group mount when explicitly enabled', async () => {
    const hostAuth = {
      auth_mode: 'chatgpt',
      tokens: { access_token: 'access-token', refresh_token: 'refresh-token' },
      OPENAI_API_KEY: null,
    };
    const loaded = await loadCodexProvider({ chatGptAuthMode: 'host-file', hostAuth });

    runContribution(loaded);
    const copiedAuthPath = path.join(loaded.dataDir, 'v2-sessions', 'ag-codex', '.codex-shared', 'auth.json');
    const copied = JSON.parse(fs.readFileSync(copiedAuthPath, 'utf-8'));

    expect(copied).toEqual(hostAuth);
    expect((fs.statSync(copiedAuthPath).mode & 0o777).toString(8)).toBe('600');
  });

  it('fails fast when ChatGPT host-file auth is enabled but host auth is missing or unusable', async () => {
    const loaded = await loadCodexProvider({
      chatGptAuthMode: 'host-file',
      hostAuth: { auth_mode: 'chatgpt', tokens: { access_token: 'access-token' } },
    });

    expect(() => runContribution(loaded)).toThrow(/CODEX_CHATGPT_AUTH=host-file is enabled/);
  });
});
