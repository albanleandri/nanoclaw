import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  attachCodexAutoApproval,
  initializeCodexAppServer,
  interruptCodexTurn,
  sendCodexRequest,
  startCodexTurn,
  startOrResumeCodexThread,
  steerCodexTurn,
  writeCodexConfigToml,
  type AppServer,
  type JsonRpcResponse,
} from './codex-app-server.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeServer(
  responder?: (request: { id?: number | string; method: string; params?: Record<string, unknown> }) => JsonRpcResponse,
): { server: AppServer; writes: Array<Record<string, unknown>> } {
  const writes: Array<Record<string, unknown>> = [];
  const server = {
    pending: new Map(),
    notificationHandlers: [],
    serverRequestHandlers: [],
    exitHandlers: [],
    readline: { close() {} },
    process: {
      stdin: {
        write(line: string) {
          const message = JSON.parse(line) as {
            id?: number | string;
            method: string;
            params?: Record<string, unknown>;
          };
          writes.push(message);
          if (message.id !== undefined && responder) {
            queueMicrotask(() => server.pending.get(message.id)?.resolve(responder(message)));
          }
          return true;
        },
      },
      kill() {},
    },
  } as unknown as AppServer;
  return { server, writes };
}

describe('Codex app-server protocol', () => {
  it('initializes and emits the initialized notification', async () => {
    const { server, writes } = fakeServer((request) => ({ id: request.id!, result: {} }));
    await initializeCodexAppServer(server);
    expect(writes.map((message) => message.method)).toEqual(['initialize', 'initialized']);
  });

  it('replaces a stale continuation with a new thread', async () => {
    const { server, writes } = fakeServer((request) =>
      request.method === 'thread/resume'
        ? { id: request.id!, error: { code: -1, message: 'thread not found' } }
        : { id: request.id!, result: { thread: { id: 'fresh-thread' } } },
    );
    await expect(
      startOrResumeCodexThread(server, 'stale-thread', {
        cwd: '/workspace/agent',
        model: 'gpt-test',
        developerInstructions: 'bounded',
      }),
    ).resolves.toBe('fresh-thread');
    expect(writes.map((message) => message.method)).toEqual(['thread/resume', 'thread/start']);
  });

  it('starts, steers, and interrupts a turn with correlated identifiers', async () => {
    const { server, writes } = fakeServer((request) => ({
      id: request.id!,
      result: request.method === 'turn/start' ? { turn: { id: 'turn-1' } } : {},
    }));
    await expect(startCodexTurn(server, { threadId: 'thread-1', inputText: 'hello', effort: 'high' })).resolves.toBe(
      'turn-1',
    );
    await steerCodexTurn(server, 'thread-1', 'turn-1', 'follow-up');
    await interruptCodexTurn(server, 'thread-1', 'turn-1');
    expect(writes.map((message) => message.method)).toEqual(['turn/start', 'turn/steer', 'turn/interrupt']);
  });

  it('times out and removes an unanswered request', async () => {
    const { server } = fakeServer();
    await expect(sendCodexRequest(server, 'never/replies', {}, 2)).rejects.toThrow('Timeout waiting');
    expect(server.pending.size).toBe(0);
  });

  it('responds to every known server approval request and rejects unknown methods', () => {
    const { server, writes } = fakeServer();
    attachCodexAutoApproval(server);
    const methods = [
      'item/commandExecution/requestApproval',
      'applyPatchApproval',
      'item/permissions/requestApproval',
      'item/tool/requestUserInput',
      'mcpServer/elicitation/request',
      'item/tool/call',
      'unknown/request',
    ];
    methods.forEach((method, index) => server.serverRequestHandlers[0]({ id: index + 1, method }));
    expect(writes).toHaveLength(methods.length);
    expect(writes.at(-1)?.error).toMatchObject({ code: -32000 });
  });

  it('writes escaped, bounded Codex configuration', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-'));
    tmpDirs.push(home);
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      writeCodexConfigToml(
        { 'tools-main': { command: 'bun', args: ['run', 'tool.ts'], env: { TOKEN: 'a"b' } } },
        { model: 'gpt-test', effort: 'high' },
      );
      const config = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
      expect(config).toContain('sandbox_mode = "danger-full-access"');
      expect(config).toContain('model = "gpt-test"');
      expect(config).toContain('[mcp_servers.tools-main]');
      expect(config).toContain('TOKEN = "a\\"b"');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
