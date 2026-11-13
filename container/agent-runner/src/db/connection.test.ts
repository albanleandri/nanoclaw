import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeSessionDb, getOutboundDb } from './connection.js';

const HOLD_LOCK = `
  const { Database } = require('bun:sqlite');
  const fs = require('node:fs');
  const [dbPath, goPath] = process.argv.slice(1);
  const db = new Database(dbPath);
  db.exec('BEGIN EXCLUSIVE');
  db.exec('CREATE TABLE IF NOT EXISTS t (x)');
  fs.writeSync(1, 'locked\\n');
  for (let i = 0; i < 2000 && !fs.existsSync(goPath); i++) Bun.sleepSync(5);
  Bun.sleepSync(300);
  db.exec('COMMIT');
`;

let tempDir: string | undefined;

afterEach(() => {
  closeSessionDb();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

test('getOutboundDb waits out another writer before setting journal mode', async () => {
  closeSessionDb();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-busy-'));
  const dbPath = path.join(tempDir, 'outbound.db');
  const goPath = path.join(tempDir, 'go');
  const holder = Bun.spawn([process.execPath, '-e', HOLD_LOCK, dbPath, goPath], {
    stdout: 'pipe',
    stderr: 'inherit',
  });

  try {
    const reader = holder.stdout.getReader();
    let output = '';
    while (!output.includes('locked')) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`lock holder exited early: ${output}`);
      output += new TextDecoder().decode(value);
    }

    fs.writeFileSync(goPath, '');
    const db = getOutboundDb(dbPath);
    expect(db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  } finally {
    fs.writeFileSync(goPath, '');
    await holder.exited;
  }
  expect(holder.exitCode).toBe(0);
});
