import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}

/**
 * True when `groups/<folder>` is present on disk in any form — directory,
 * file, or symlink, empty or not. `ncl groups delete` never removes the
 * folder, so presence with no claiming DB row is deleted-group residue (or an
 * operator-placed dir), and creating a group over it would silently adopt the
 * old group's memory and data under a new identity (ported from upstream
 * 92a3518b). lstat, not existsSync: existsSync follows symlinks, so a dangling
 * symlink would read as absent while still occupying the name.
 */
export function groupFolderExistsOnDisk(folder: string): boolean {
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  try {
    fs.lstatSync(groupPath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err; // e.g. EACCES: cannot tell, so refuse rather than adopt
  }
}
