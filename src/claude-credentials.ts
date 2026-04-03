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

import { logger } from './logger.js';

export interface ClaudeOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix milliseconds
  scopes: string[];
  subscriptionType: string;
  rateLimitTier: string;
}

export const CREDENTIALS_PATH = path.join(
  os.homedir(),
  '.claude',
  '.credentials.json',
);

const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
const REFRESH_TIMEOUT_MS = 10_000; // abort if the token endpoint doesn't respond

// OAuth client ID for Claude Code CLI — must match the value hardcoded in the CLI binary.
// Omitting this causes the endpoint to return "Invalid request format".
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// Refresh 5 minutes before actual expiry to avoid races
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Read credentials from the given file path (defaults to ~/.claude/.credentials.json).
 * Returns null if the file is missing, unreadable, or malformed.
 */
export function readClaudeCredentials(
  filePath = CREDENTIALS_PATH,
): ClaudeOAuthCredentials | null {
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

export type TokenFetcher = (
  refreshToken: string,
  scopes: string[],
) => Promise<ClaudeOAuthCredentials | null>;

export async function defaultFetcher(
  refreshToken: string,
  scopes: string[],
): Promise<ClaudeOAuthCredentials | null> {
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
              logger.error(
                { status: res.statusCode, data },
                'Token refresh failed',
              );
              resolve(null);
              return;
            }
            const expiresAt = data.expires_in
              ? Date.now() + data.expires_in * 1000
              : Date.now() + 8 * 60 * 60 * 1000; // default 8h
            resolve({
              accessToken: data.access_token,
              refreshToken: data.refresh_token ?? refreshToken,
              expiresAt,
              scopes:
                typeof data.scope === 'string' ? data.scope.split(' ') : [],
              subscriptionType: data.subscription_type ?? '',
              rateLimitTier: data.rate_limit_tier ?? '',
            });
          } catch (err) {
            logger.error({ err }, 'Failed to parse token refresh response');
            resolve(null);
          }
        });
      },
    );

    req.setTimeout(REFRESH_TIMEOUT_MS, () => {
      req.destroy();
    });

    req.on('error', (err: Error) => {
      logger.error({ err }, 'Token refresh request failed');
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

function writeClaudeCredentials(
  creds: ClaudeOAuthCredentials,
  filePath: string,
): void {
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
    logger.error({ err }, 'Failed to write refreshed Claude credentials');
  }
}

/**
 * Return a valid access token, refreshing automatically if needed.
 * Returns null only when no credentials file exists at all.
 * Falls back to the expired token if refresh fails (server will reject it,
 * but at least we tried).
 */
export async function getValidClaudeOAuthToken(
  filePath = CREDENTIALS_PATH,
  fetcher?: TokenFetcher,
): Promise<string | null> {
  const creds = readClaudeCredentials(filePath);
  if (!creds) return null;

  if (!isTokenExpired(creds.expiresAt)) {
    return creds.accessToken;
  }

  if (!creds.refreshToken) {
    logger.warn(
      'Claude OAuth credentials have no refreshToken — cannot refresh',
    );
    return creds.accessToken;
  }

  logger.info('Claude OAuth token expired or expiring soon, refreshing...');
  const refresh = fetcher ?? defaultFetcher;
  const newCreds = await refresh(creds.refreshToken, creds.scopes);

  if (!newCreds) {
    logger.warn(
      'Token refresh failed — using potentially expired token as fallback',
    );
    return creds.accessToken;
  }

  writeClaudeCredentials(newCreds, filePath);
  return newCreds.accessToken;
}
