import { describe, it, expect, vi } from 'vitest';
import { readClaudeCredentials, updateOnecliSecret, refreshOnecliToken } from './onecli-token-refresh.js';

// --- readClaudeCredentials ---

describe('readClaudeCredentials', () => {
  it('returns accessToken and expiresAt from valid credentials file', async () => {
    const file = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-abc',
        expiresAt: 1778893153872,
      },
    });
    const readFile = vi.fn().mockResolvedValue(file);

    const result = await readClaudeCredentials('/fake/path/.credentials.json', readFile);

    expect(result.accessToken).toBe('sk-ant-oat01-abc');
    expect(result.expiresAt).toBe(1778893153872);
    expect(readFile).toHaveBeenCalledWith('/fake/path/.credentials.json', 'utf-8');
  });

  it('throws when the credentials file is missing', async () => {
    const readFile = vi.fn().mockRejectedValue(Object.assign(new Error('no such file'), { code: 'ENOENT' }));

    await expect(readClaudeCredentials('/missing/.credentials.json', readFile)).rejects.toThrow(
      'credentials file not found',
    );
  });

  it('throws when the file contains invalid JSON', async () => {
    const readFile = vi.fn().mockResolvedValue('not json {{{');

    await expect(readClaudeCredentials('/fake/.credentials.json', readFile)).rejects.toThrow(
      'failed to parse credentials file',
    );
  });

  it('throws when claudeAiOauth key is absent', async () => {
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ someOtherKey: {} }));

    await expect(readClaudeCredentials('/fake/.credentials.json', readFile)).rejects.toThrow(
      'claudeAiOauth.accessToken missing',
    );
  });

  it('throws when accessToken is an empty string', async () => {
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: '', expiresAt: 9999 } }));

    await expect(readClaudeCredentials('/fake/.credentials.json', readFile)).rejects.toThrow(
      'claudeAiOauth.accessToken missing',
    );
  });

  it('defaults expiresAt to 0 when omitted', async () => {
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-xyz' } }));

    const result = await readClaudeCredentials('/fake/.credentials.json', readFile);

    expect(result.expiresAt).toBe(0);
  });
});

// --- updateOnecliSecret ---

describe('updateOnecliSecret', () => {
  it('sends PATCH with the token and returns on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('{"success":true}'),
    });

    await updateOnecliSecret({
      onecliUrl: 'http://172.17.0.1:10254',
      secretId: 'sec-123',
      token: 'sk-ant-oat01-newtoken',
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://172.17.0.1:10254/api/secrets/sec-123');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ value: 'sk-ant-oat01-newtoken' });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('throws a descriptive error when OneCLI returns a non-2xx status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue('Not Found'),
    });

    await expect(
      updateOnecliSecret({
        onecliUrl: 'http://172.17.0.1:10254',
        secretId: 'sec-bad',
        token: 'tok',
        fetch: fetchMock,
      }),
    ).rejects.toThrow('OneCLI secret update failed: 404 Not Found');
  });

  it('propagates network errors from fetch', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      updateOnecliSecret({
        onecliUrl: 'http://172.17.0.1:10254',
        secretId: 'sec-123',
        token: 'tok',
        fetch: fetchMock,
      }),
    ).rejects.toThrow('ECONNREFUSED');
  });
});

// --- refreshOnecliToken (orchestrator) ---

describe('refreshOnecliToken', () => {
  it('reads credentials and updates the OneCLI secret', async () => {
    const readFile = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-fresh', expiresAt: 9999999999999 } }),
      );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('{"success":true}'),
    });

    await refreshOnecliToken({
      credentialsPath: '/home/user/.claude/.credentials.json',
      onecliUrl: 'http://172.17.0.1:10254',
      secretId: 'sec-abc',
      readFile,
      fetch: fetchMock,
    });

    expect(readFile).toHaveBeenCalledWith('/home/user/.claude/.credentials.json', 'utf-8');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://172.17.0.1:10254/api/secrets/sec-abc');
    expect(JSON.parse(init.body as string).value).toBe('sk-ant-oat01-fresh');
  });

  it('propagates credential read errors before touching OneCLI', async () => {
    const readFile = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const fetchMock = vi.fn();

    await expect(
      refreshOnecliToken({
        credentialsPath: '/missing/.credentials.json',
        onecliUrl: 'http://172.17.0.1:10254',
        secretId: 'sec-abc',
        readFile,
        fetch: fetchMock,
      }),
    ).rejects.toThrow('credentials file not found');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates OneCLI update errors', async () => {
    const readFile = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: 9999 } }));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('Internal Server Error'),
    });

    await expect(
      refreshOnecliToken({
        credentialsPath: '/fake/.credentials.json',
        onecliUrl: 'http://172.17.0.1:10254',
        secretId: 'sec-abc',
        readFile,
        fetch: fetchMock,
      }),
    ).rejects.toThrow('OneCLI secret update failed: 500');
  });
});
