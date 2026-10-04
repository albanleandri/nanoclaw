import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostIntegrationOperationError } from './invoker.js';
import { createFamilyAgendaAdapter, familyAgendaAdapter } from './family-agenda-adapter.js';
import { createHostIntegrationRegistry, requireHostIntegrationAdapter } from './registry.js';
import type { HostIntegrationOperation } from './types.js';

const CONFIG = { tenant: 'example-town' };
const PROTECTED = { username: 'parent', password: 'SENTINEL_PASSWORD', personId: '3' };
const INPUT = { from: '2026-10-03', days: 3 };

type AdapterOperation = HostIntegrationOperation<typeof CONFIG, typeof PROTECTED>;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function html(body = '<html></html>', init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(body, { ...init, headers });
}

function successfulResponses(calendar: unknown = validCalendar()): Response[] {
  return [
    html('', { headers: { 'set-cookie': 'sid=one; Path=/' } }),
    html('', { headers: { 'set-cookie': 'anti=two; Path=/' } }),
    Response.json({ Status: 'OK' }, { headers: { 'set-cookie': 'auth=three; Path=/' } }),
    new Response('', {
      status: 302,
      headers: { location: '/example-town/espace-citoyens/CompteCitoyen' },
    }),
    html('account'),
    html('detail'),
    Response.json(calendar),
  ];
}

function validCalendar(): unknown {
  return {
    EvenementsGroupes: [{ IdGroupeEvt: 1, LibNomGroupeEvt: 'Cantine', LibComplementGroupeEvt: '<b>École</b>' }],
    EvenementSystemes: [
      {
        DateEvenement: '20261003',
        IdGroupeEvt: 1,
        HeureDebutEvenement: '1200',
        HeureFinEvenement: '1300',
        LibEvenement: '<strong>Repas</strong>',
        LibCorpsEvenement: 'Confirmé',
        ListeActions: [{ UrlAction: '/dangerous/delete', LibAction: 'Delete' }],
      },
      { DateEvenement: '20261010', IdGroupeEvt: 1, LibEvenement: 'Outside window' },
    ],
  };
}

function operation(fetchImpl: FetchLike): AdapterOperation {
  const registered = createFamilyAgendaAdapter(fetchImpl).operations['agenda.read'];
  if (!registered) throw new Error('agenda.read operation missing');
  return registered;
}

async function execute(fetchImpl: FetchLike, signal = new AbortController().signal): Promise<unknown> {
  const selected = operation(fetchImpl);
  return selected.execute({
    config: CONFIG,
    protectedPayload: PROTECTED,
    input: selected.validateInput(INPUT),
    signal,
  });
}

async function expectFailure(promise: Promise<unknown>, resultClass: string): Promise<HostIntegrationOperationError> {
  const error = await promise.then(
    () => new Error('Expected operation to fail'),
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(HostIntegrationOperationError);
  expect(error).toMatchObject({ resultClass });
  expect(String(error)).not.toContain(PROTECTED.password);
  return error as HostIntegrationOperationError;
}

describe('family agenda adapter declaration', () => {
  it('registers an exact read-only trusted-host adapter with classified protected fields', () => {
    const registry = createHostIntegrationRegistry();
    registry.register(familyAgendaAdapter);

    const registered = registry.require('family-agenda', 1);
    expect(registered.securityTier).toBe('trusted-host');
    expect(registered.operations['agenda.read']?.sideEffects).toBe('none');
    expect(Object.isFrozen(familyAgendaAdapter.operations['agenda.read'])).toBe(true);
    expect(registered.protectedFields).toEqual([
      { name: 'username', sensitivity: 'private', label: 'Portal username' },
      { name: 'password', sensitivity: 'secret', label: 'Portal password' },
      { name: 'personId', sensitivity: 'private', label: 'Portal person selector' },
    ]);
    expect(registered.validateConfig(CONFIG)).toEqual(CONFIG);
    expect(registered.validateProtectedPayload(PROTECTED)).toEqual(PROTECTED);
  });

  it('is registered by the production integration barrel', async () => {
    await import('./index.js');
    expect(requireHostIntegrationAdapter('family-agenda', 1).operations).toHaveProperty('agenda.read');
  });

  it('rejects unknown config, protected-payload, and input fields', () => {
    expect(() => familyAgendaAdapter.validateConfig({ ...CONFIG, personId: '3' })).toThrow();
    expect(() => familyAgendaAdapter.validateProtectedPayload({ ...PROTECTED, agentGroupId: 'lumo' })).toThrow();
    expect(() => familyAgendaAdapter.operations['agenda.read']?.validateInput({ ...INPUT, extra: true })).toThrow();
  });

  it('declares a fixed HTTPS origin and exact path/query allowlist', () => {
    const selected = familyAgendaAdapter.operations['agenda.read']!;
    const destination = selected.network.destinations[0]!;
    expect(destination.origin).toBe('https://www.espace-citoyens.net');
    expect(destination.methods).toEqual(['GET', 'POST']);
    expect(destination.isAllowedUrl(new URL(`${destination.origin}/example-town/espace-citoyens/`), CONFIG)).toBe(true);
    expect(
      destination.isAllowedUrl(
        new URL(`${destination.origin}/example-town/espace-citoyens/FichePersonne/DetailPersonne?idDynamic=3`),
        CONFIG,
      ),
    ).toBe(true);
    expect(destination.isAllowedUrl(new URL('https://evil.example/example-town/espace-citoyens/'), CONFIG)).toBe(false);
    expect(
      destination.isAllowedUrl(new URL(`${destination.origin}/example-town/espace-citoyens/Admin/Delete`), CONFIG),
    ).toBe(false);
    expect(
      destination.isAllowedUrl(
        new URL(`${destination.origin}/example-town/espace-citoyens/FichePersonne/DetailPersonne?idDynamic=3&x=1`),
        CONFIG,
      ),
    ).toBe(false);
  });
});

describe('family agenda adapter network flow', () => {
  it('uses only fixed-origin requests, bounded cookies, and inert normalized output', async () => {
    const responses = successfulResponses();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected request');
      return response;
    });

    const result = await execute(fetchMock);

    expect(result).toEqual({
      from: '2026-10-03',
      through: '2026-10-05',
      events: [
        {
          date: '2026-10-03',
          start: '12:00',
          end: '13:00',
          title: 'Repas',
          activity: 'Cantine',
          location: 'École',
          detail: 'Confirmé',
        },
      ],
    });
    expect(calls).toHaveLength(7);
    expect(calls.every((call) => call.url.startsWith('https://www.espace-citoyens.net/example-town/'))).toBe(true);
    expect(calls.every((call) => call.init.redirect === 'manual')).toBe(true);
    expect(new Headers(calls[2]!.init.headers).get('cookie')).toContain('sid=one');
    expect(new Headers(calls[2]!.init.headers).get('cookie')).toContain('anti=two');
    expect(String(calls[2]!.init.body)).toContain('SENTINEL_PASSWORD');
    expect(JSON.stringify(result)).not.toContain('SENTINEL_PASSWORD');
    expect(JSON.stringify(result)).not.toContain('dangerous');
  });

  it('accepts explicit null collections as a structurally valid empty agenda', async () => {
    const responses = successfulResponses({ EvenementsGroupes: null, EvenementSystemes: null });
    const result = await execute(async () => responses.shift()!);
    expect(result).toEqual({ from: '2026-10-03', through: '2026-10-05', events: [] });
  });

  it('rejects a cross-origin login redirect before making the redirected request', async () => {
    const responses = [html(), html(), Response.json({ Status: 'OK', LocationHref: 'https://evil.example/steal' })];
    const fetchMock = vi.fn(async () => responses.shift()!);

    await expectFailure(execute(fetchMock), 'upstream_contract_changed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects an allowlisted-origin redirect to an unreviewed path', async () => {
    const responses = [
      html(),
      html(),
      Response.json({ Status: 'OK', LocationHref: '/example-town/espace-citoyens/Admin/Delete' }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);

    await expectFailure(execute(fetchMock), 'upstream_contract_changed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('enforces the manual redirect hop limit', async () => {
    const redirect = (location: string) => new Response('', { status: 302, headers: { location } });
    const responses = [
      html(),
      html(),
      Response.json({ Status: 'OK' }),
      redirect('/example-town/espace-citoyens/CompteCitoyen'),
      redirect('/example-town/espace-citoyens/'),
      redirect('/example-town/espace-citoyens/CompteCitoyen'),
      redirect('/example-town/espace-citoyens/'),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);

    await expectFailure(execute(fetchMock), 'upstream_contract_changed');
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('does not retry an authentication POST or rejected login', async () => {
    const rejected = [html(), html(), Response.json({ Status: 'NO', Message: PROTECTED.password })];
    const rejectedFetch = vi.fn(async () => rejected.shift()!);
    await expectFailure(execute(rejectedFetch), 'authentication_rejected');
    expect(rejectedFetch).toHaveBeenCalledTimes(3);

    const failed = [html(), html()];
    const failedFetch = vi.fn(async () => {
      const response = failed.shift();
      if (response) return response;
      throw new Error(PROTECTED.password);
    });
    await expectFailure(execute(failedFetch), 'upstream_transient');
    expect(failedFetch).toHaveBeenCalledTimes(3);
  });

  it('retries an idempotent GET once for a transient status', async () => {
    const responses = [new Response('', { status: 503 }), ...successfulResponses()];
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return responses.shift()!;
    });

    await execute(fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(urls[0]).toBe(urls[1]);
  });

  it('retries an idempotent GET once for a transient connection failure', async () => {
    const responses = successfulResponses();
    let first = true;
    const fetchMock = vi.fn(async () => {
      if (first) {
        first = false;
        throw new Error(PROTECTED.password);
      }
      return responses.shift()!;
    });

    const result = await execute(fetchMock);

    expect(result).toMatchObject({ from: INPUT.from });
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('fails safely after the single GET retry is exhausted', async () => {
    const fetchMock = vi.fn(async () => new Response(PROTECTED.password, { status: 503 }));
    await expectFailure(execute(fetchMock), 'upstream_transient');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized headers, cookies, and bodies', async () => {
    const headerFetch = vi.fn(async () => html('', { headers: { 'x-oversized': 'x'.repeat(33 * 1024) } }));
    await expectFailure(execute(headerFetch), 'upstream_contract_changed');

    const cookieFetch = vi.fn(async () => html('', { headers: { 'set-cookie': `sid=${'x'.repeat(9 * 1024)}` } }));
    await expectFailure(execute(cookieFetch), 'upstream_contract_changed');

    const bodyFetch = vi.fn(async () => html('x'.repeat(2 * 1024 * 1024 + 1)));
    await expectFailure(execute(bodyFetch), 'upstream_contract_changed');
  });

  it('rejects a response that exceeds the cookie-count limit', async () => {
    const headers = new Headers({ 'content-type': 'text/html' });
    for (let index = 0; index < 33; index++) headers.append('set-cookie', `cookie${index}=value; Path=/`);
    const fetchMock = vi.fn(async () => new Response('', { headers }));

    await expectFailure(execute(fetchMock), 'upstream_contract_changed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps an HTML calendar/login fallback and schema drift to contract-safe failures', async () => {
    const htmlFallback = successfulResponses();
    htmlFallback[6] = html(`<body>${PROTECTED.password}</body>`);
    await expectFailure(
      execute(async () => htmlFallback.shift()!),
      'authentication_rejected',
    );

    const drifted = successfulResponses({ EvenementsGroupes: [], PartialEvents: [] });
    await expectFailure(
      execute(async () => drifted.shift()!),
      'upstream_contract_changed',
    );
  });

  it('enforces the per-request deadline and aborts the in-flight fetch', async () => {
    vi.useFakeTimers();
    let observedAbort = false;
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init: RequestInit = {}) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              reject(new Error(PROTECTED.password));
            },
            { once: true },
          );
        }),
    );
    const pending = execute(fetchMock);
    const assertion = expectFailure(pending, 'upstream_timeout');
    await vi.advanceTimersByTimeAsync(8_000);

    await assertion;
    expect(observedAbort).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
