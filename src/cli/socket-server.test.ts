import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { startCliServer, stopCliServer } from './socket-server.js';

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
});
