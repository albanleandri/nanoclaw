import os from 'os';
import path from 'path';

import { CLAUDE_ONECLI_SECRET_ID, ONECLI_URL } from './config.js';
import { log } from './log.js';
import { refreshOnecliToken } from './onecli-token-refresh.js';

export const CLAUDE_TOKEN_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function reconcileClaudeToken(): Promise<void> {
  if (!CLAUDE_ONECLI_SECRET_ID) return;
  if (running) {
    log.warn('Claude credential reconciliation already running; skipping overlapping tick');
    return;
  }

  running = true;
  try {
    await refreshOnecliToken({
      credentialsPath: path.join(os.homedir(), '.claude', '.credentials.json'),
      onecliUrl: ONECLI_URL ?? 'http://172.17.0.1:10254',
      secretId: CLAUDE_ONECLI_SECRET_ID,
    });
    log.info('Claude credential reconciled into OneCLI');
  } catch (err) {
    // Keep the host alive and retry next tick. refreshOnecliToken refuses to
    // replace the vault value with a known-expired token.
    log.error('Claude credential reconciliation failed', { err });
  } finally {
    running = false;
  }
}

export function startClaudeTokenMaintenance(): void {
  if (!CLAUDE_ONECLI_SECRET_ID) {
    log.info('Claude credential maintenance disabled (CLAUDE_ONECLI_SECRET_ID is not configured)');
    return;
  }
  if (timer) return;

  void reconcileClaudeToken();
  timer = setInterval(() => void reconcileClaudeToken(), CLAUDE_TOKEN_RECONCILE_INTERVAL_MS);
  timer.unref();
  log.info('Claude credential maintenance started', {
    intervalMs: CLAUDE_TOKEN_RECONCILE_INTERVAL_MS,
  });
}

export function stopClaudeTokenMaintenance(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
