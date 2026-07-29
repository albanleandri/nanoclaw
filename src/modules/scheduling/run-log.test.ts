import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmp: string;

vi.mock('../../config.js', () => ({ GROUPS_DIR: process.env.TEST_GROUPS_DIR as string }));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => (id === 'ag-1' ? { id: 'ag-1', folder: 'telegram_main' } : undefined),
}));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runlog-'));
  process.env.TEST_GROUPS_DIR = tmp;
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('appendRunLog', () => {
  it('creates the tasks dir and appends one timestamped line per call', async () => {
    const { appendRunLog } = await import('./run-log.js');
    appendRunLog('ag-1', 'daily-1a2b', 'first');
    const out = appendRunLog('ag-1', 'daily-1a2b', 'second');

    expect(out.path).toBe(path.join(tmp, 'telegram_main', 'tasks', 'daily-1a2b.md'));
    const lines = fs.readFileSync(out.path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z — first$/);
    expect(lines[1].endsWith(' — second')).toBe(true);
  });

  // Regression for the ncl-tasks port — the charset guard IS the path-traversal
  // boundary. `ncl tasks append-log` accepts an agent-supplied --id.
  it('rejects a series id that could escape the tasks directory', async () => {
    const { appendRunLog } = await import('./run-log.js');
    expect(() => appendRunLog('ag-1', '../../etc/passwd', 'x')).toThrow('invalid task id');
    expect(() => appendRunLog('ag-1', 'Daily_1A2B', 'x')).toThrow('invalid task id');
    expect(() => appendRunLog('ag-1', '', 'x')).toThrow('invalid task id');
  });

  it('rejects an unknown agent group', async () => {
    const { appendRunLog } = await import('./run-log.js');
    expect(() => appendRunLog('ag-missing', 'daily-1a2b', 'x')).toThrow('agent group not found');
  });
});
