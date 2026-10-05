import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { MAX_CLI_FRAME_BYTES } from './limits.js';
import { register } from './registry.js';
import { SocketTransport } from './socket-client.js';
import { assertNoLiveCliServer, startCliServer, stopCliServer } from './socket-server.js';

register({
  name: 'phase3-socket-ping',
  description: 'Test-only socket command.',
  access: 'open',
  parseArgs: (args) => args,
  handler: async () => ({ pong: true }),
});

let socketPath: string | null = null;

afterEach(async () => {
  await stopCliServer();
  if (socketPath && fs.existsSync(socketPath)) fs.rmSync(socketPath);
  socketPath = null;
});

describe('startCliServer socket permissions', () => {
  it('creates the socket owner-only (0600)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-sock-'));
    socketPath = path.join(dir, 'ncl.sock');

    await startCliServer(socketPath);

    const mode = fs.statSync(socketPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('accepts exactly one bounded request frame per half-closed connection', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-sock-'));
    socketPath = path.join(dir, 'ncl.sock');
    await startCliServer(socketPath);

    const response = await new SocketTransport(socketPath).sendFrame({
      id: 'request-1',
      command: 'phase3-socket-ping',
      args: {},
    });
    expect(response).toEqual({ id: 'request-1', ok: true, data: { pong: true } });
  });

  it('rejects malformed multi-frame input without reflecting protected content', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-sock-'));
    socketPath = path.join(dir, 'ncl.sock');
    await startCliServer(socketPath);
    const sentinel = 'SENTINEL_SECOND_FRAME_SECRET';
    const first = JSON.stringify({ id: 'one', command: 'phase3-socket-ping', args: {} });
    const second = JSON.stringify({ id: 'two', command: 'phase3-socket-ping', args: { protected_payload: sentinel } });

    const response = await sendRaw(socketPath, `${first}\n${second}\n`);
    expect(response).toContain('bad request frame');
    expect(response).not.toContain(sentinel);
  });

  it('rejects oversized input with a bounded non-reflecting error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-sock-'));
    socketPath = path.join(dir, 'ncl.sock');
    await startCliServer(socketPath);
    const sentinel = 'SENTINEL_OVERSIZED_SECRET';

    const response = await sendRaw(socketPath, sentinel.repeat(Math.ceil(MAX_CLI_FRAME_BYTES / sentinel.length) + 1));
    expect(response).toContain('safe size limit');
    expect(response).not.toContain(sentinel);
    expect(Buffer.byteLength(response)).toBeLessThan(MAX_CLI_FRAME_BYTES);
  });
});

// Ported from upstream 31f7fda2. Before this, a second host started in the same
// checkout unlinked the live socket and took over every `ncl` call; it had also
// already reaped the first host's containers by the time it got here.
describe('startCliServer single-bind', () => {
  it('refuses to take over a socket a live server is answering on', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-sock-'));
    socketPath = path.join(dir, 'ncl.sock');
    const other = net.createServer();
    await new Promise<void>((resolve) => other.listen(socketPath!, resolve));
    try {
      await expect(assertNoLiveCliServer(socketPath)).rejects.toThrow(/another host instance/);
      await expect(startCliServer(socketPath)).rejects.toThrow(/another host instance/);
      expect(fs.existsSync(socketPath)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it('reclaims a stale socket path nobody answers on', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-sock-'));
    socketPath = path.join(dir, 'ncl.sock');
    fs.writeFileSync(socketPath, '');

    await expect(assertNoLiveCliServer(socketPath)).resolves.toBeUndefined();
    await startCliServer(socketPath);
    const response = await new SocketTransport(socketPath).sendFrame({
      id: 'after-stale',
      command: 'phase3-socket-ping',
      args: {},
    });
    expect(response).toEqual({ id: 'after-stale', ok: true, data: { pong: true } });
  });
});

async function sendRaw(socket: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    let response = '';
    client.on('connect', () => client.end(payload));
    client.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });
    client.on('end', () => resolve(response));
    client.on('error', reject);
  });
}
