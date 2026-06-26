import fs from 'fs/promises';
import { getValidClaudeOAuthToken } from './claude-credentials.js';

export interface ClaudeCredentials {
  accessToken: string;
  expiresAt: number;
}

export async function readClaudeCredentials(
  credentialsPath: string,
  readFile: (path: string, encoding: 'utf-8') => Promise<string> = fs.readFile,
): Promise<ClaudeCredentials> {
  let raw: string;
  try {
    raw = await readFile(credentialsPath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(`credentials file not found: ${credentialsPath}` + (code ? ` (${code})` : ''), { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new Error(`failed to parse credentials file: ${credentialsPath}`, { cause: err });
  }

  const token =
    parsed != null &&
    typeof parsed === 'object' &&
    'claudeAiOauth' in parsed &&
    parsed.claudeAiOauth != null &&
    typeof parsed.claudeAiOauth === 'object' &&
    'accessToken' in parsed.claudeAiOauth
      ? (parsed.claudeAiOauth as Record<string, unknown>).accessToken
      : undefined;

  if (typeof token !== 'string' || token === '') {
    throw new Error(`claudeAiOauth.accessToken missing or empty in ${credentialsPath}`);
  }

  const expiresAt =
    parsed != null &&
    typeof parsed === 'object' &&
    'claudeAiOauth' in parsed &&
    parsed.claudeAiOauth != null &&
    typeof parsed.claudeAiOauth === 'object' &&
    'expiresAt' in parsed.claudeAiOauth
      ? Number((parsed.claudeAiOauth as Record<string, unknown>).expiresAt)
      : 0;

  return { accessToken: token, expiresAt: isNaN(expiresAt) ? 0 : expiresAt };
}

export async function updateOnecliSecret(opts: {
  onecliUrl: string;
  secretId: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}): Promise<void> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const url = `${opts.onecliUrl}/api/secrets/${opts.secretId}`;
  const res = await fetchFn(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: opts.token }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OneCLI secret update failed: ${res.status} ${body}`);
  }
}

export async function refreshOnecliToken(opts: {
  credentialsPath: string;
  onecliUrl: string;
  secretId: string;
  getToken?: (credentialsPath: string) => Promise<string | null>;
  readCreds?: (credentialsPath: string) => Promise<ClaudeCredentials>;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
}): Promise<void> {
  const getTokenFn = opts.getToken ?? ((p: string) => getValidClaudeOAuthToken(p));
  const token = await getTokenFn(opts.credentialsPath);
  if (!token) throw new Error('No Claude credentials available');

  // getValidClaudeOAuthToken falls back to the stale access token when its
  // OAuth refresh fails (e.g. invalid_grant). Pushing an already-expired token
  // into the vault 401's every container until the next successful refresh —
  // the failure that caused a multi-day silent outage. Refuse to overwrite the
  // vault with a token we know is expired and keep the last-known-good secret.
  const readCredsFn = opts.readCreds ?? ((p: string) => readClaudeCredentials(p));
  const now = opts.now ?? (() => Date.now());
  const { expiresAt } = await readCredsFn(opts.credentialsPath);
  if (expiresAt && expiresAt <= now()) {
    throw new Error(
      `Refusing to push expired Claude token to OneCLI (expired ${new Date(expiresAt).toISOString()}); ` +
        `keeping last-known-good secret. A re-login on the host is required.`,
    );
  }

  await updateOnecliSecret({
    onecliUrl: opts.onecliUrl,
    secretId: opts.secretId,
    token,
    fetch: opts.fetch,
  });
}
