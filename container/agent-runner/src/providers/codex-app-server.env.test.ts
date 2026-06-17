import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildCodexProcessEnv } from './codex-app-server.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeCodexHome(auth: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth));
  return dir;
}

describe('buildCodexProcessEnv', () => {
  it('bypasses OneCLI proxy for ChatGPT websocket auth', () => {
    const codexHome = makeCodexHome({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'access', refresh_token: 'refresh' },
    });

    const env = buildCodexProcessEnv({
      HOME: '/home/node',
      CODEX_HOME: codexHome,
      HTTPS_PROXY: 'http://proxy:10255',
      NO_PROXY: 'localhost',
    });

    expect(env.HTTPS_PROXY).toBe('http://proxy:10255');
    expect(env.NO_PROXY).toBe('localhost,chatgpt.com,.chatgpt.com');
    expect(env.no_proxy).toBe('localhost,chatgpt.com,.chatgpt.com');
  });

  it('does not bypass proxy for non-ChatGPT auth', () => {
    const codexHome = makeCodexHome({ auth_mode: 'api', OPENAI_API_KEY: 'sk-test' });

    const env = buildCodexProcessEnv({
      HOME: '/home/node',
      CODEX_HOME: codexHome,
      HTTPS_PROXY: 'http://proxy:10255',
    });

    expect(env.HTTPS_PROXY).toBe('http://proxy:10255');
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
  });
});
