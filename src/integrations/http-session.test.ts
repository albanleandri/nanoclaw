import { describe, expect, it, vi } from 'vitest';

import { HostIntegrationOperationError } from './invoker.js';
import { createBoundedHostHttpSession } from './http-session.js';
import type { HostIntegrationOperation } from './types.js';

const CONFIG = { scope: 'demo' };

function operation(overrides: Partial<HostIntegrationOperation<typeof CONFIG, object>['network']> = {}) {
  return {
    network: {
      destinations: [
        {
          origin: 'https://records.example.test',
          methods: ['GET', 'POST'] as const,
          isAllowedUrl: (url: URL) =>
            url.origin === 'https://records.example.test' &&
            (url.pathname === '/allowed' || url.pathname === '/next') &&
            !url.search,
        },
      ],
      maxRedirects: 2,
      requestDeadlineMs: 100,
      maxCookies: 2,
      retry: {
        methods: ['GET'] as const,
        statuses: [502, 503, 504],
        maxAttempts: 2,
        maxRetryAfterMs: 1,
      },
      ...overrides,
    },
    responseLimits: {
      maxHeaderBytes: 1_024,
      maxCookieBytes: 128,
      maxBodyBytes: 128,
      maxNormalizedOutputBytes: 128,
    },
  } as Pick<HostIntegrationOperation<typeof CONFIG, object>, 'network' | 'responseLimits'>;
}

function response(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

async function expectClass(promise: Promise<unknown>, resultClass: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'HostIntegrationOperationError', resultClass });
}

describe('bounded host HTTP session', () => {
  it('rejects undeclared URLs and methods before fetch', async () => {
    const fetchImpl = vi.fn();
    const session = createBoundedHostHttpSession({
      config: CONFIG,
      operation: operation(),
      signal: new AbortController().signal,
      fetchImpl,
    });
    await expectClass(
      session.request({
        url: new URL('https://records.example.test/forbidden'),
        acceptedContentTypes: ['application/json'],
      }),
      'upstream_contract_changed',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bounds content type, body, headers, and cookies', async () => {
    const cases: Array<() => Response> = [
      () => response('ok', { headers: { 'content-type': 'text/html' } }),
      () => response('x'.repeat(129)),
      () => response('{}', { headers: { 'content-type': 'application/json', 'x-large': 'x'.repeat(1_100) } }),
      () => response('{}', { headers: { 'content-type': 'application/json', 'set-cookie': 'a=' + 'x'.repeat(200) } }),
    ];
    for (const makeResponse of cases) {
      const session = createBoundedHostHttpSession({
        config: CONFIG,
        operation: operation({ retry: { methods: [], statuses: [], maxAttempts: 1, maxRetryAfterMs: 0 } }),
        signal: new AbortController().signal,
        fetchImpl: async () => makeResponse(),
      });
      await expectClass(
        session.request({
          url: new URL('https://records.example.test/allowed'),
          acceptedContentTypes: ['application/json'],
        }),
        'upstream_contract_changed',
      );
    }
  });

  it('keeps cookies invocation-local and sends only bounded pairs', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response('{}', { headers: { 'content-type': 'application/json', 'set-cookie': 'session=opaque; Secure' } }),
      )
      .mockResolvedValueOnce(response('{"ok":true}'));
    const session = createBoundedHostHttpSession({
      config: CONFIG,
      operation: operation(),
      signal: new AbortController().signal,
      fetchImpl,
    });
    await session.request({
      url: new URL('https://records.example.test/allowed'),
      acceptedContentTypes: ['application/json'],
    });
    const result = await session.request({
      url: new URL('https://records.example.test/allowed'),
      acceptedContentTypes: ['application/json'],
    });
    expect(result.json()).toEqual({ ok: true });
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get('cookie')).toBe('session=opaque');
  });

  it('never sends a cookie to a different allowed origin', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response('{}', { headers: { 'content-type': 'application/json', 'set-cookie': 'session=opaque; Secure' } }),
      )
      .mockResolvedValueOnce(response('{}'));
    const crossOriginOperation = operation({
      destinations: [
        ...operation().network.destinations,
        {
          origin: 'https://archive.example.test',
          methods: ['GET'],
          isAllowedUrl: (url: URL) => url.origin === 'https://archive.example.test' && url.pathname === '/allowed',
        },
      ],
    });
    const session = createBoundedHostHttpSession({
      config: CONFIG,
      operation: crossOriginOperation,
      signal: new AbortController().signal,
      fetchImpl,
    });
    await session.request({
      url: new URL('https://records.example.test/allowed'),
      acceptedContentTypes: ['application/json'],
    });
    await session.request({
      url: new URL('https://archive.example.test/allowed'),
      acceptedContentTypes: ['application/json'],
    });
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).has('cookie')).toBe(false);
  });

  it('retries only declared idempotent GET failures', async () => {
    const getFetch = vi
      .fn()
      .mockResolvedValueOnce(response('', { status: 503 }))
      .mockResolvedValueOnce(response('{}'));
    const getSession = createBoundedHostHttpSession({
      config: CONFIG,
      operation: operation(),
      signal: new AbortController().signal,
      fetchImpl: getFetch,
    });
    await getSession.request({
      url: new URL('https://records.example.test/allowed'),
      acceptedContentTypes: ['application/json'],
    });
    expect(getFetch).toHaveBeenCalledTimes(2);

    const postFetch = vi.fn().mockResolvedValue(response('', { status: 503 }));
    const postSession = createBoundedHostHttpSession({
      config: CONFIG,
      operation: operation(),
      signal: new AbortController().signal,
      fetchImpl: postFetch,
    });
    await expectClass(
      postSession.request({
        url: new URL('https://records.example.test/allowed'),
        method: 'POST',
        body: new URLSearchParams({ value: 'opaque' }),
        acceptedContentTypes: ['application/json'],
      }),
      'upstream_transient',
    );
    expect(postFetch).toHaveBeenCalledTimes(1);
  });

  it('validates every redirect hop and enforces the hop bound', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response('', { status: 302, headers: { location: '/next' } }))
      .mockResolvedValueOnce(response('{}'));
    const session = createBoundedHostHttpSession({
      config: CONFIG,
      operation: operation(),
      signal: new AbortController().signal,
      fetchImpl,
    });
    const result = await session.followRedirects(new URL('https://records.example.test/allowed'), {
      acceptedContentTypes: ['application/json'],
      validateRedirect: (_from, to) => to.pathname === '/next',
    });
    expect(result.json()).toEqual({});

    const rejecting = createBoundedHostHttpSession({
      config: CONFIG,
      operation: operation(),
      signal: new AbortController().signal,
      fetchImpl: async () => response('', { status: 302, headers: { location: 'https://evil.example/next' } }),
    });
    await expectClass(
      rejecting.followRedirects(new URL('https://records.example.test/allowed'), {
        acceptedContentTypes: ['application/json'],
      }),
      'upstream_contract_changed',
    );
  });

  it('maps per-request timeout and propagates caller cancellation', async () => {
    const timeoutSession = createBoundedHostHttpSession({
      config: CONFIG,
      operation: operation({
        requestDeadlineMs: 5,
        retry: { methods: [], statuses: [], maxAttempts: 1, maxRetryAfterMs: 0 },
      }),
      signal: new AbortController().signal,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    await expectClass(
      timeoutSession.request({
        url: new URL('https://records.example.test/allowed'),
        acceptedContentTypes: ['application/json'],
      }),
      'upstream_timeout',
    );

    const controller = new AbortController();
    const cancelled = createBoundedHostHttpSession({
      config: CONFIG,
      operation: operation(),
      signal: controller.signal,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    const request = cancelled.request({
      url: new URL('https://records.example.test/allowed'),
      acceptedContentTypes: ['application/json'],
    });
    controller.abort();
    await expect(request).rejects.not.toBeInstanceOf(HostIntegrationOperationError);
  });
});
