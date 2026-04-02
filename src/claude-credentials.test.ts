import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  readClaudeCredentials,
  isTokenExpired,
  getValidClaudeOAuthToken,
  type ClaudeOAuthCredentials,
} from './claude-credentials.js';

const FUTURE = Date.now() + 2 * 60 * 60 * 1000; // 2 hours from now
const PAST = Date.now() - 60 * 1000; // 1 minute ago
const SOON = Date.now() + 3 * 60 * 1000; // 3 min from now (within 5-min buffer)

function makeCreds(overrides: Partial<ClaudeOAuthCredentials> = {}): ClaudeOAuthCredentials {
  return {
    accessToken: 'sk-ant-oat01-valid',
    refreshToken: 'sk-ant-ort01-refresh',
    expiresAt: FUTURE,
    scopes: ['user:inference'],
    subscriptionType: 'pro',
    rateLimitTier: 'default',
    ...overrides,
  };
}

function writeCredentialsFile(tmpDir: string, creds: ClaudeOAuthCredentials): string {
  const filePath = path.join(tmpDir, '.credentials.json');
  fs.writeFileSync(filePath, JSON.stringify({ claudeAiOauth: creds }));
  return filePath;
}

describe('readClaudeCredentials', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-creds-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns credentials when file exists with valid content', () => {
    const creds = makeCreds();
    const filePath = writeCredentialsFile(tmpDir, creds);

    const result = readClaudeCredentials(filePath);

    expect(result).toEqual(creds);
  });

  it('returns null when file does not exist', () => {
    const result = readClaudeCredentials(path.join(tmpDir, 'missing.json'));
    expect(result).toBeNull();
  });

  it('returns null when file contains invalid JSON', () => {
    const filePath = path.join(tmpDir, '.credentials.json');
    fs.writeFileSync(filePath, 'not json {{{');
    const result = readClaudeCredentials(filePath);
    expect(result).toBeNull();
  });

  it('returns null when claudeAiOauth key is absent', () => {
    const filePath = path.join(tmpDir, '.credentials.json');
    fs.writeFileSync(filePath, JSON.stringify({ somethingElse: {} }));
    const result = readClaudeCredentials(filePath);
    expect(result).toBeNull();
  });
});

describe('isTokenExpired', () => {
  it('returns false when token expires well in the future', () => {
    expect(isTokenExpired(FUTURE)).toBe(false);
  });

  it('returns true when token already expired', () => {
    expect(isTokenExpired(PAST)).toBe(true);
  });

  it('returns true when token expires within the 5-minute buffer', () => {
    expect(isTokenExpired(SOON)).toBe(true);
  });

  it('returns false when token expires exactly at the buffer boundary', () => {
    const justBeyondBuffer = Date.now() + 5 * 60 * 1000 + 1000;
    expect(isTokenExpired(justBeyondBuffer)).toBe(false);
  });
});

describe('getValidClaudeOAuthToken', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-creds-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns current accessToken when not expired', async () => {
    const creds = makeCreds({ expiresAt: FUTURE });
    const filePath = writeCredentialsFile(tmpDir, creds);
    const mockFetcher = vi.fn();

    const token = await getValidClaudeOAuthToken(filePath, mockFetcher);

    expect(token).toBe('sk-ant-oat01-valid');
    expect(mockFetcher).not.toHaveBeenCalled();
  });

  it('returns null when credentials file does not exist', async () => {
    const token = await getValidClaudeOAuthToken(
      path.join(tmpDir, 'missing.json'),
    );
    expect(token).toBeNull();
  });

  it('calls fetcher and returns new token when expired', async () => {
    const creds = makeCreds({ expiresAt: PAST });
    const filePath = writeCredentialsFile(tmpDir, creds);
    const newCreds = makeCreds({
      accessToken: 'sk-ant-oat01-refreshed',
      refreshToken: 'sk-ant-ort01-new',
      expiresAt: FUTURE,
    });
    const mockFetcher = vi.fn().mockResolvedValue(newCreds);

    const token = await getValidClaudeOAuthToken(filePath, mockFetcher);

    expect(token).toBe('sk-ant-oat01-refreshed');
    expect(mockFetcher).toHaveBeenCalledWith('sk-ant-ort01-refresh');
  });

  it('writes refreshed credentials back to file', async () => {
    const creds = makeCreds({ expiresAt: PAST });
    const filePath = writeCredentialsFile(tmpDir, creds);
    const newCreds = makeCreds({
      accessToken: 'sk-ant-oat01-refreshed',
      expiresAt: FUTURE,
    });
    const mockFetcher = vi.fn().mockResolvedValue(newCreds);

    await getValidClaudeOAuthToken(filePath, mockFetcher);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(written.claudeAiOauth.accessToken).toBe('sk-ant-oat01-refreshed');
    expect(written.claudeAiOauth.expiresAt).toBe(FUTURE);
  });

  it('preserves other top-level keys in the credentials file when writing back', async () => {
    const creds = makeCreds({ expiresAt: PAST });
    const filePath = path.join(tmpDir, '.credentials.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({ claudeAiOauth: creds, someOtherKey: 'preserved' }),
    );
    const newCreds = makeCreds({ accessToken: 'sk-ant-oat01-refreshed', expiresAt: FUTURE });
    const mockFetcher = vi.fn().mockResolvedValue(newCreds);

    await getValidClaudeOAuthToken(filePath, mockFetcher);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(written.someOtherKey).toBe('preserved');
    expect(written.claudeAiOauth.accessToken).toBe('sk-ant-oat01-refreshed');
  });

  it('falls back to expired token when refresh fails', async () => {
    const creds = makeCreds({ expiresAt: PAST });
    const filePath = writeCredentialsFile(tmpDir, creds);
    const mockFetcher = vi.fn().mockResolvedValue(null);

    const token = await getValidClaudeOAuthToken(filePath, mockFetcher);

    expect(token).toBe('sk-ant-oat01-valid');
  });
});

