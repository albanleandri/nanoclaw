/**
 * Task-series run log — one host-timestamped line per event, at
 * `<GROUPS_DIR>/<group folder>/tasks/<series>.md`.
 *
 * Two writers, one format:
 *   - `ncl tasks append-log` (agent's explicit mid-run/work-log entry)
 *   - the `task_log` outbound row a task fire's final text produces
 *     (container/agent-runner poll-loop auto-append; delivery.ts routes it here)
 */
/* eslint-disable no-catch-all/no-catch-all -- filesystem reads deliberately fail closed for every error */
import fs from 'fs';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';

export function isValidTaskSeriesId(series: string): boolean {
  return /^[a-z0-9-]+$/.test(series);
}

function taskLogPath(agentGroupId: string, series: string, createDir: boolean): string | null {
  if (!isValidTaskSeriesId(series)) return null;
  const ag = getAgentGroup(agentGroupId);
  if (!ag) return null;
  const dir = `${GROUPS_DIR}/${ag.folder}/tasks`;
  if (createDir) fs.mkdirSync(dir, { recursive: true });
  try {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`unsafe task log directory: ${dir}`);
    }
  } catch (err) {
    if (!createDir && (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return `${dir}/${series}.md`;
}

export function appendRunLog(
  agentGroupId: string,
  series: string,
  msg: string,
): { series: string; timestamp: string; path: string } {
  // Charset guard is the security boundary: blocks path traversal and keeps
  // the id safe as a filename. Callers resolve group scope before this.
  if (!isValidTaskSeriesId(series)) throw new Error(`invalid task id: ${series}`);
  const ag = getAgentGroup(agentGroupId);
  if (!ag) throw new Error(`agent group not found: ${agentGroupId}`);

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const file = taskLogPath(agentGroupId, series, true)!;
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeSync(fd, `${timestamp} — ${msg}\n`);
  } finally {
    fs.closeSync(fd);
  }
  return { series, timestamp, path: file };
}

export function readRunLogTail(agentGroupId: string, series: string, lines = 10): string[] {
  let file: string | null;
  try {
    file = taskLogPath(agentGroupId, series, false);
  } catch {
    return [];
  }
  if (!file) return [];
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return [];
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return [];
    return fs.readFileSync(fd, 'utf8').trimEnd().split('\n').filter(Boolean).slice(-lines);
  } finally {
    fs.closeSync(fd);
  }
}
