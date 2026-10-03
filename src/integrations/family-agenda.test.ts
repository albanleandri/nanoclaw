import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchFamilyAgenda,
  loadFamilyAgendaCredential,
  normalizeAgenda,
  type FamilyAgendaCredential,
} from './family-agenda.js';

const TEST_ROOT = '/tmp/nanoclaw-test-family-agenda';

afterEach(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

describe('family agenda credential loading', () => {
  it('loads an owner-only local credential', () => {
    const directory = path.join(TEST_ROOT, 'private-integrations');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'family-agenda.json'),
      JSON.stringify({
        username: 'parent',
        password: 'secret',
        agentGroupId: 'lumo',
        tenant: 'example-town',
        personId: '3',
      }),
      { mode: 0o600 },
    );
    expect(loadFamilyAgendaCredential({ dataDir: TEST_ROOT, credentialsDirectory: '' })).toEqual({
      username: 'parent',
      password: 'secret',
      agentGroupId: 'lumo',
      tenant: 'example-town',
      personId: '3',
    });
  });

  it('rejects a local credential readable by other users', () => {
    const directory = path.join(TEST_ROOT, 'private-integrations');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'family-agenda.json'), '{}', { mode: 0o644 });
    expect(() => loadFamilyAgendaCredential({ dataDir: TEST_ROOT, credentialsDirectory: '' })).toThrow(
      /must not be accessible/,
    );
  });
});

describe('family agenda normalization', () => {
  it('treats explicit null collections as a valid empty agenda', () => {
    expect(normalizeAgenda({ EvenementsGroupes: null, EvenementSystemes: null })).toEqual([]);
  });

  it('keeps only inert normalized event fields and strips markup', () => {
    const result = normalizeAgenda({
      EvenementsGroupes: [
        { IdGroupeEvt: 9, LibNomGroupeEvt: 'Accueil &amp; loisirs', LibComplementGroupeEvt: '<b>École</b>' },
      ],
      EvenementSystemes: [
        {
          DateEvenement: '20261005',
          IdGroupeEvt: 9,
          HeureDebutEvenement: '730',
          HeureFinEvenement: '1800',
          LibEvenement: '<strong>Présence</strong>',
          LibCorpsEvenement: 'Confirmée&nbsp;!',
          ListeActions: [{ UrlAction: '/dangerous/mutation', LibAction: 'Cancel' }],
        },
      ],
    });
    expect(result).toEqual([
      {
        date: '2026-10-05',
        start: '07:30',
        end: '18:00',
        title: 'Présence',
        activity: 'Accueil & loisirs',
        location: 'École',
        detail: 'Confirmée !',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('dangerous');
  });
});

describe('family agenda HTTP client', () => {
  it('logs in, carries cookies, and returns only the requested date window', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const responses = [
      new Response('<html></html>', { headers: { 'content-type': 'text/html', 'set-cookie': 'sid=one; Path=/' } }),
      new Response('<input name="__RequestVerificationToken" value="token&amp;value">', {
        headers: { 'content-type': 'text/html', 'set-cookie': 'anti=two; Path=/' },
      }),
      Response.json({ Status: 'OK' }, { headers: { 'set-cookie': 'auth=three; Path=/' } }),
      new Response('', {
        status: 302,
        headers: { location: '/example-town/espace-citoyens/CompteCitoyen' },
      }),
      new Response('<html>authenticated account root</html>', { headers: { 'content-type': 'text/html' } }),
      new Response('<html>authenticated detail</html>', { headers: { 'content-type': 'text/html' } }),
      Response.json({
        EvenementsGroupes: [{ IdGroupeEvt: 1, LibNomGroupeEvt: 'Cantine', LibComplementGroupeEvt: '' }],
        EvenementSystemes: [
          { DateEvenement: '20261003', IdGroupeEvt: 1, LibEvenement: 'Repas' },
          { DateEvenement: '20261010', IdGroupeEvt: 1, LibEvenement: 'Hors fenêtre' },
        ],
      }),
    ];
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      const response = responses.shift();
      if (!response) throw new Error('unexpected request');
      return response;
    });
    const credential: FamilyAgendaCredential = {
      username: 'parent',
      password: 'secret',
      agentGroupId: 'lumo',
      tenant: 'example-town',
      personId: '3',
    };

    const result = await fetchFamilyAgenda(credential, { from: '2026-10-03', days: 3 }, fetchMock);

    expect(result).toMatchObject({ from: '2026-10-03', through: '2026-10-05' });
    expect(result.events).toHaveLength(1);
    expect(calls).toHaveLength(7);
    expect(calls.every((call) => call.url.startsWith('https://www.espace-citoyens.net/example-town/'))).toBe(true);
    expect(new Headers(calls[2].init.headers).get('cookie')).toContain('sid=one');
    expect(new Headers(calls[2].init.headers).get('cookie')).toContain('anti=two');
    const loginBody = calls[2].init.body as URLSearchParams;
    expect(loginBody.get('__RequestVerificationToken')).toBeNull();
    expect(loginBody.get('username')).toBe('parent');
    expect(loginBody.get('returnUrl')).toBe('');
  });

  it('fails closed when the calendar endpoint returns a login page', async () => {
    const responses = [
      new Response('', { headers: { 'content-type': 'text/html' } }),
      new Response('', { headers: { 'content-type': 'text/html' } }),
      Response.json({ Status: 'OK' }),
      new Response('<html>authenticated account root</html>', { headers: { 'content-type': 'text/html' } }),
      new Response('<html>authenticated detail</html>', { headers: { 'content-type': 'text/html' } }),
      new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    await expect(
      fetchFamilyAgenda(
        { username: 'u', password: 'p', agentGroupId: 'lumo', tenant: 'example-town', personId: '3' },
        { from: '2026-10-03', days: 3 },
        fetchMock,
      ),
    ).rejects.toThrow(/calendar response was not JSON/);
  });
});
