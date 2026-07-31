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
  vi.resetModules();
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

  it('exposes the same charset guard for run-log readers', async () => {
    const { isValidTaskSeriesId } = await import('./run-log.js');
    expect(isValidTaskSeriesId('daily-report-a1b2')).toBe(true);
    expect(isValidTaskSeriesId('../../private')).toBe(false);
    expect(isValidTaskSeriesId('Daily_Report')).toBe(false);
  });

  it('rejects symlinked task directories and log files for host writes', async () => {
    const { appendRunLog } = await import('./run-log.js');
    const probe = appendRunLog('ag-1', 'probe', 'locate root');
    const group = path.dirname(path.dirname(probe.path));
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.rmSync(path.join(group, 'tasks'), { recursive: true });
    fs.symlinkSync(outside, path.join(group, 'tasks'));
    expect(() => appendRunLog('ag-1', 'daily-1a2b', 'x')).toThrow('unsafe task log directory');

    fs.unlinkSync(path.join(group, 'tasks'));
    fs.mkdirSync(path.join(group, 'tasks'));
    const target = path.join(outside, 'target.md');
    fs.writeFileSync(target, 'keep\n');
    fs.symlinkSync(target, path.join(group, 'tasks', 'daily-1a2b.md'));
    expect(() => appendRunLog('ag-1', 'daily-1a2b', 'x')).toThrow(/symbolic link|ELOOP/);
    expect(fs.readFileSync(target, 'utf8')).toBe('keep\n');
    fs.rmSync(path.join(group, 'tasks'), { recursive: true });
  });

  it('fails closed when reading a symlinked run log', async () => {
    const { appendRunLog, readRunLogTail } = await import('./run-log.js');
    const probe = appendRunLog('ag-1', 'daily-1a2b', 'locate root');
    const dir = path.dirname(probe.path);
    const target = path.join(tmp, 'private.md');
    fs.writeFileSync(target, 'secret\n');
    fs.unlinkSync(probe.path);
    fs.symlinkSync(target, path.join(dir, 'daily-1a2b.md'));
    expect(readRunLogTail('ag-1', 'daily-1a2b')).toEqual([]);
  });

  it('rejects an unknown agent group', async () => {
    const { appendRunLog } = await import('./run-log.js');
    expect(() => appendRunLog('ag-missing', 'daily-1a2b', 'x')).toThrow('agent group not found');
  });
});
