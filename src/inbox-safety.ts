/**
 * Shared containment guard for host writes into a container-writable session
 * inbox. Both the inbox root and per-message directory must be real
 * directories: otherwise a runner can pre-place a symlink and redirect a host
 * attachment write outside the session.
 */
/* eslint-disable no-catch-all/no-catch-all -- this boundary intentionally converts every filesystem error into a rejected write */
import fs from 'fs';
import path from 'path';

import { log } from './log.js';

export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function ensureContainedInboxDir(
  inboxRoot: string,
  messageId: string,
  context: Record<string, unknown>,
): string | null {
  const inboxDir = path.join(inboxRoot, messageId);

  for (const dir of [inboxRoot, inboxDir]) {
    try {
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        log.warn('Rejecting unsafe inbox path', { ...context, dir });
        return null;
      }
    } catch (err) {
      // lstat can fail for reasons other than absence; all failures are handled
      // explicitly and fail closed.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('Failed to inspect inbox path', { ...context, dir, err });
        return null;
      }
    }
  }

  try {
    fs.mkdirSync(inboxDir, { recursive: true });
    const realInboxRoot = fs.realpathSync(inboxRoot);
    const realInboxDir = fs.realpathSync(inboxDir);
    if (!isPathInside(realInboxRoot, realInboxDir)) {
      log.warn('Inbox directory escaped inbox root', { ...context, inboxDir });
      return null;
    }
    return realInboxDir;
  } catch (err) {
    // Any mkdir/realpath failure must reject the host write.
    log.warn('Failed to create or resolve inbox directory', { ...context, inboxDir, err });
    return null;
  }
}
