/**
 * Read and refresh Claude Code OAuth credentials from ~/.claude/.credentials.json.
 * Used by the credential proxy as a fallback when no API key or OAuth token is
 * configured in .env, so container agents can use the host's Claude subscription
 * instead of the pay-per-token API.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { request as httpsRequest } from 'https';

import { log } from './log.js';

export interface ClaudeOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix milliseconds
  scopes: string[];
  subscriptionType: string;
  rateLimitTier: string;
}

export const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
const REFRESH_TIMEOUT_MS = 10_000; // abort if the token endpoint doesn't respond

// OAuth client ID for Claude Code CLI — must match the value hardcoded in the CLI binary.
// Omitting this causes the endpoint to return "Invalid request format".
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// Refresh well before actual expiry. The credential is reconciled into OneCLI
// every five minutes, so a 15-minute buffer guarantees multiple opportunities
// to refresh and publish it before Anthropic can reject a request.
export const EXPIRY_BUFFER_MS = 15 * 60 * 1000;

/**
 * Read credentials from the given file path (defaults to ~/.claude/.credentials.json).
 * Returns null if the file is missing, unreadable, or malformed.
 */
export function readClaudeCredentials(filePath = CREDENTIALS_PATH): ClaudeOAuthCredentials | null {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return (data?.claudeAiOauth as ClaudeOAuthCredentials) ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns true if the token should be refreshed (expired or within the buffer window).
 */
export function isTokenExpired(expiresAt: number): boolean {
  return Date.now() >= expiresAt - EXPIRY_BUFFER_MS;
}

export type TokenFetcher = (refreshToken: string, scopes: string[]) => Promise<ClaudeOAuthCredentials | null>;

export async function defaultFetcher(refreshToken: string, scopes: string[]): Promise<ClaudeOAuthCredentials | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
      scope: scopes.join(' '),
    });

    const url = new URL(REFRESH_URL);
    const req = httpsRequest(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            if (!data.access_token) {
              // Log only the standard OAuth error fields, never the whole body
              // — the response from a token endpoint can carry credential
              // material and should not land in logs verbatim.
              log.error('Token refresh failed', {
                status: res.statusCode,
                error: data.error,
                errorDescription: data.error_description,
              });
              resolve(null);
              return;
            }
            const expiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : Date.now() + 8 * 60 * 60 * 1000; // default 8h
            resolve({
              accessToken: data.access_token,
              refreshToken: data.refresh_token ?? refreshToken,
              expiresAt,
              scopes: typeof data.scope === 'string' ? data.scope.split(' ') : [],
              subscriptionType: data.subscription_type ?? '',
              rateLimitTier: data.rate_limit_tier ?? '',
            });
          } catch (err) {
            log.error('Failed to parse token refresh response', { err });
            resolve(null);
          }
        });
      },
    );

    req.setTimeout(REFRESH_TIMEOUT_MS, () => {
      req.destroy();
    });

    req.on('error', (err: Error) => {
      log.error('Token refresh request failed', { err });
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

function writeClaudeCredentials(creds: ClaudeOAuthCredentials, filePath: string): void {
  try {
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      // File may not exist yet or be unreadable; start fresh
    }
    existing.claudeAiOauth = creds;
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n');
  } catch (err) {
    log.error('Failed to write refreshed Claude credentials', { err });
  }
}

// Cross-process serialization for the refresh critical section. The shared
// ~/.claude/.credentials.json is refreshed by multiple uncoordinated parties
// (this host's hourly OneCLI-refresh timer, the host's native credential
// proxy, and the interactive Claude Code CLI). Claude's OAuth server *rotates*
// the refresh token on every refresh, so two refreshers racing on the same
// file each invalidate the other's refresh token → invalid_grant → a forced
// re-login and a dead token served to containers. A file lock plus a re-read
// inside the lock means whoever refreshes first wins and everyone else reuses
// that result instead of refreshing again.
const LOCK_TIMEOUT_MS = 15_000; // never block longer than this — degrade to best-effort
const LOCK_STALE_MS = 30_000; // a lock older than this is from a crashed process
const LOCK_POLL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire a best-effort cross-process lock for the credentials file. Returns a
 * release function. Never throws and never deadlocks: a stale lock (from a
 * crashed process) is broken, and if the lock can't be taken within the
 * timeout we proceed without it rather than hang the caller forever.
 */
async function acquireCredentialsLock(filePath: string): Promise<() => void> {
  const lockPath = `${filePath}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx'); // atomic create-if-absent
      fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}`);
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Already gone (e.g. broken as stale by another process) — fine.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        // Unexpected fs error (permissions, read-only mount, …) — don't block
        // refresh on lock bookkeeping; degrade to best-effort with no lock.
        return () => {};
      }
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue; // retry immediately now that the stale lock is gone
        }
      } catch {
        continue; // lock vanished between open and stat — retry
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        log.warn('Credential refresh lock wait timed out — proceeding without lock');
        return () => {};
      }
      await sleep(LOCK_POLL_MS);
    }
  }
}

/**
 * Return a valid access token, refreshing automatically if needed.
 * Returns null only when no credentials file exists at all.
 *
 * The refresh is serialized via a cross-process lock and re-reads the file
 * inside the lock, so a token another process just refreshed is reused rather
 * than rotated away. If our own refresh fails (commonly invalid_grant after
 * our refresh token was rotated by another process), we re-read once more
 * before falling back to the stale token.
 */
export async function getValidClaudeOAuthToken(
  filePath = CREDENTIALS_PATH,
  fetcher?: TokenFetcher,
): Promise<string | null> {
  const creds = readClaudeCredentials(filePath);
  if (!creds) return null;

  // Fast path: a valid token needs no lock — keeps per-request proxy reads
  // cheap and avoids any lock churn when nothing needs refreshing.
  if (!isTokenExpired(creds.expiresAt)) {
    return creds.accessToken;
  }

  if (!creds.refreshToken) {
    log.warn('Claude OAuth credentials have no refreshToken — cannot refresh');
    return creds.accessToken;
  }

  const release = await acquireCredentialsLock(filePath);
  try {
    // Re-read inside the lock — another refresher may have updated the file
    // while we waited. Reuse their fresh token instead of refreshing again.
    const latest = readClaudeCredentials(filePath) ?? creds;
    if (!isTokenExpired(latest.expiresAt)) {
      return latest.accessToken;
    }
    if (!latest.refreshToken) {
      log.warn('Claude OAuth credentials have no refreshToken — cannot refresh');
      return latest.accessToken;
    }

    log.info('Claude OAuth token expired or expiring soon, refreshing...');
    const refresh = fetcher ?? defaultFetcher;
    const newCreds = await refresh(latest.refreshToken, latest.scopes);

    if (!newCreds) {
      // Refresh failed. A concurrent external refresher (the Claude Code CLI)
      // may have just written a valid token — prefer that over a dead one.
      const afterFail = readClaudeCredentials(filePath);
      if (afterFail && !isTokenExpired(afterFail.expiresAt)) {
        return afterFail.accessToken;
      }
      log.warn('Token refresh failed — using potentially expired token as fallback');
      return latest.accessToken;
    }

    writeClaudeCredentials(newCreds, filePath);
    return newCreds.accessToken;
  } finally {
    release();
  }
}
