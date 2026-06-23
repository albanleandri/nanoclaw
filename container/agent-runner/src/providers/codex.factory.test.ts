import { describe, expect, it } from 'bun:test';

import { CodexProvider, type CodexRuntimeDeps } from './codex.js';
import type { AppServer, JsonRpcNotification } from './codex-app-server.js';

describe('CodexProvider', () => {
  it('rejects unsupported reasoning effort values', () => {
    expect(() => new CodexProvider({ effort: 'max' })).toThrow(/Unsupported Codex reasoning effort/);
  });

  it('normalizes supported reasoning effort values', () => {
    expect(new CodexProvider({ effort: 'HIGH' })).toBeInstanceOf(CodexProvider);
  });

  it('accepts supported reasoning effort values', () => {
    expect(new CodexProvider({ effort: 'xhigh' })).toBeInstanceOf(CodexProvider);
  });

  it('queues follow-ups as separate turns and acknowledges them only after their result', async () => {
    let server!: AppServer;
    const startedInputs: string[] = [];
    let steerCalls = 0;
    let killed = false;

    const runtime: CodexRuntimeDeps = {
      writeCodexConfigToml() {},
      spawnCodexAppServer() {
        server = {
          process: {} as AppServer['process'],
          readline: {} as AppServer['readline'],
          pending: new Map(),
          notificationHandlers: [],
          serverRequestHandlers: [],
          exitHandlers: [],
        };
        return server;
      },
      attachCodexAutoApproval() {},
      async initializeCodexAppServer() {},
      async startOrResumeCodexThread() {
        return 'thread-1';
      },
      async startCodexTurn(_server, params) {
        startedInputs.push(params.inputText);
        const turnId = `turn-${startedInputs.length}`;
        queueMicrotask(() => notify(server, { method: 'turn/started', params: { turn: { id: turnId } } }));
        return turnId;
      },
      async steerCodexTurn() {
        steerCalls += 1;
      },
      async interruptCodexTurn() {},
      killCodexAppServer() {
        killed = true;
      },
    };

    const provider = new CodexProvider({}, runtime);
    const query = provider.query({ prompt: 'first', cwd: '/workspace/agent' });
    let followUpAcked = false;
    const results: string[] = [];

    const consumer = (async () => {
      for await (const event of query.events) {
        if (event.type === 'result' && event.text) results.push(event.text);
        if (results.length === 2) query.end();
      }
    })();

    await waitFor(() => startedInputs.length === 1);
    query.push('second', () => {
      followUpAcked = true;
    });

    expect(steerCalls).toBe(0);
    expect(startedInputs).toEqual(['first']);

    completeTurn(server, 'first result');
    await waitFor(() => startedInputs.length === 2);

    expect(followUpAcked).toBe(false);
    expect(startedInputs).toEqual(['first', 'second']);

    completeTurn(server, 'second result');
    await waitFor(() => followUpAcked);
    await consumer;

    expect(results).toEqual(['first result', 'second result']);
    expect(killed).toBe(true);
  });
});

function notify(server: AppServer, notification: JsonRpcNotification): void {
  for (const handler of [...server.notificationHandlers]) handler(notification);
}

function completeTurn(server: AppServer, text: string): void {
  notify(server, {
    method: 'turn/completed',
    params: {
      turn: {
        items: [{ type: 'agentMessage', text }],
      },
    },
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
