import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';

const ORIGIN = 'https://www.espace-citoyens.net';
const CREDENTIAL_NAME = 'family-agenda.json';

export interface FamilyAgendaCredential {
  username: string;
  password: string;
  agentGroupId: string;
  tenant: string;
  personId: string;
}

export interface FamilyAgendaEvent {
  date: string;
  start: string | null;
  end: string | null;
  title: string;
  activity: string | null;
  location: string | null;
  detail: string | null;
}

export interface FamilyAgendaResult {
  from: string;
  through: string;
  events: FamilyAgendaEvent[];
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function loadFamilyAgendaCredential(
  options: {
    dataDir?: string;
    credentialsDirectory?: string;
  } = {},
): FamilyAgendaCredential {
  const credentialsDirectory = options.credentialsDirectory ?? process.env.CREDENTIALS_DIRECTORY;
  const systemdPath = credentialsDirectory ? path.join(credentialsDirectory, CREDENTIAL_NAME) : undefined;
  const localPath = path.join(options.dataDir ?? DATA_DIR, 'private-integrations', CREDENTIAL_NAME);
  const credentialPath = systemdPath && fs.existsSync(systemdPath) ? systemdPath : localPath;

  let raw: string;
  try {
    const stat = fs.statSync(credentialPath);
    if (!stat.isFile()) throw new Error('not a regular file');
    if (credentialPath === localPath && (stat.mode & 0o077) !== 0) {
      throw new Error('local credential file must not be accessible by group or other users');
    }
    raw = fs.readFileSync(credentialPath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Family agenda credential is unavailable or unsafe (${reason})`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('Family agenda credential is not valid JSON', { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Family agenda credential must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  const credential: FamilyAgendaCredential = {
    username: requiredString(record.username, 'username'),
    password: requiredString(record.password, 'password', false),
    agentGroupId: requiredString(record.agentGroupId, 'agentGroupId'),
    tenant: requiredString(record.tenant, 'tenant'),
    personId: requiredString(record.personId, 'personId'),
  };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(credential.tenant)) {
    throw new Error('Family agenda tenant must contain only lowercase letters, digits, and hyphens');
  }
  if (!/^\d+$/.test(credential.personId)) throw new Error('Family agenda personId must contain only digits');
  return credential;
}

export async function fetchFamilyAgenda(
  credential: FamilyAgendaCredential,
  options: { from: string; days: number },
  fetchImpl: FetchLike = fetch,
): Promise<FamilyAgendaResult> {
  if (!isIsoDate(options.from)) throw new Error('--from must be a valid date in YYYY-MM-DD form');
  if (!Number.isInteger(options.days) || options.days < 1 || options.days > 31) {
    throw new Error('--days must be an integer between 1 and 31');
  }

  const portalRoot = `/${credential.tenant}/espace-citoyens`;
  const cookies = new Map<string, string>();
  const request = async (
    stage: string,
    pathname: string,
    init: RequestInit = {},
    allowRedirect = false,
  ): Promise<Response> => {
    if (!pathname.startsWith(`${portalRoot}/`) && pathname !== `${portalRoot}/`) {
      throw new Error('Family agenda request path is not allowlisted');
    }
    const headers = new Headers(init.headers);
    if (cookies.size > 0) {
      headers.set('cookie', [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; '));
    }
    const response = await fetchImpl(new URL(pathname, ORIGIN), { ...init, headers, redirect: 'manual' });
    rememberCookies(response.headers, cookies);
    if (response.status >= 300 && response.status < 400) {
      if (allowRedirect) return response;
      throw new Error(`Family agenda ${stage} request was redirected; the session was not accepted`);
    }
    if (!response.ok) throw new Error(`Family agenda ${stage} request failed with HTTP ${response.status}`);
    return response;
  };

  const navigate = async (stage: string, initialPath: string): Promise<string> => {
    let pathname = initialPath;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await request(stage, pathname, { headers: { accept: 'text/html' } }, true);
      if (response.status < 300 || response.status >= 400) {
        await response.text();
        return pathname;
      }
      const location = response.headers.get('location');
      if (!location) throw new Error(`Family agenda ${stage} redirect did not provide a location`);
      await response.text();
      pathname = portalPath(location, portalRoot);
    }
    throw new Error(`Family agenda ${stage} exceeded the redirect limit`);
  };

  await request('landing', `${portalRoot}/`, { headers: { accept: 'text/html' } });
  const modal = await request('login form', `${portalRoot}/Home/RecupererModaleConnexion`, {
    method: 'POST',
    headers: { accept: 'text/html', 'x-requested-with': 'XMLHttpRequest' },
  });
  await modal.text();

  const form = new URLSearchParams({
    username: credential.username,
    password: credential.password,
    returnUrl: '',
  });
  const login = await request('login', `${portalRoot}/Home/LogonAjax`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
    },
    body: form,
  });
  const loginResult = await safeJson(login, 'login');
  const loginRecord =
    loginResult && typeof loginResult === 'object' && !Array.isArray(loginResult)
      ? (loginResult as Record<string, unknown>)
      : {};
  const loginStatus = String(loginRecord.Status ?? loginRecord.status ?? '');
  if (loginStatus.toUpperCase() !== 'OK') throw new Error('Family agenda login was rejected');

  const detailPath = `${portalRoot}/FichePersonne/DetailPersonne?idDynamic=${encodeURIComponent(credential.personId)}`;
  const locationValue = loginRecord.locationHref ?? loginRecord.LocationHref;
  const loginLocation =
    locationValue === undefined || locationValue === null || locationValue === ''
      ? `${portalRoot}/`
      : portalPath(locationValue, portalRoot);
  const landedPath = await navigate('post-login navigation', loginLocation);
  if (landedPath !== detailPath) {
    await request('detail', detailPath, { headers: { accept: 'text/html' } });
  }

  const calendar = await request(
    'calendar',
    `${portalRoot}/FichePersonne/DetailPersonneGetCalendrier?idDynamic=${encodeURIComponent(credential.personId)}`,
    {
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        referer: new URL(detailPath, ORIGIN).toString(),
        'x-requested-with': 'XMLHttpRequest',
      },
    },
  );
  const payload = await safeJson(calendar, 'calendar');
  const through = addDays(options.from, options.days - 1);
  return {
    from: options.from,
    through,
    events: normalizeAgenda(payload).filter((event) => event.date >= options.from && event.date <= through),
  };
}

export function normalizeAgenda(payload: unknown): FamilyAgendaEvent[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Family agenda calendar response has an invalid shape');
  }
  const root = payload as Record<string, unknown>;
  const groupValues = eventCollection(root, 'EvenementsGroupes');
  const eventValues = eventCollection(root, 'EvenementSystemes');

  const groups = new Map<string, { activity: string | null; location: string | null }>();
  for (const value of groupValues) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const group = value as Record<string, unknown>;
    const id = scalar(group.IdGroupeEvt);
    if (!id) continue;
    groups.set(id, {
      activity: cleanText(group.LibNomGroupeEvt),
      location: cleanText(group.LibComplementGroupeEvt),
    });
  }

  const events: FamilyAgendaEvent[] = [];
  for (const value of eventValues) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const event = value as Record<string, unknown>;
    const date = normalizePortalDate(event.DateEvenement);
    const title = cleanText(event.LibEvenement);
    if (!date || !title) continue;
    const group = groups.get(scalar(event.IdGroupeEvt) ?? '') ?? { activity: null, location: null };
    events.push({
      date,
      start: normalizePortalTime(event.HeureDebutEvenement),
      end: normalizePortalTime(event.HeureFinEvenement),
      title,
      activity: group.activity,
      location: group.location,
      detail: cleanText(event.LibCorpsEvenement),
    });
  }
  return events.sort((a, b) =>
    [a.date, a.start ?? '', a.activity ?? '', a.title]
      .join('\0')
      .localeCompare([b.date, b.start ?? '', b.activity ?? '', b.title].join('\0'), 'fr'),
  );
}

function eventCollection(root: Record<string, unknown>, name: string): unknown[] {
  const value = root[name];
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error('Family agenda calendar response is missing event collections');
  return value;
}

function requiredString(value: unknown, name: string, trim = true): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Family agenda credential field ${name} is required`);
  return trim ? value.trim() : value;
}

function rememberCookies(headers: Headers, jar: Map<string, string>): void {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const values = extended.getSetCookie?.() ?? (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
  for (const value of values) {
    const pair = value.split(';', 1)[0];
    const equals = pair.indexOf('=');
    if (equals <= 0) continue;
    jar.set(pair.slice(0, equals).trim(), pair.slice(equals + 1).trim());
  }
}

async function safeJson(response: Response, label: string): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('json')) throw new Error(`Family agenda ${label} response was not JSON`);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Family agenda ${label} response was invalid JSON`, { cause: error });
  }
}

function scalar(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function portalPath(value: unknown, portalRoot: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Family agenda login response did not provide a navigation location');
  }
  const url = new URL(value, ORIGIN);
  const pathname = `${url.pathname}${url.search}`;
  if (url.origin !== ORIGIN || (!pathname.startsWith(`${portalRoot}/`) && pathname !== `${portalRoot}/`)) {
    throw new Error('Family agenda login response provided a navigation location outside the configured portal');
  }
  return pathname;
}

function cleanText(value: unknown): string | null {
  const text = scalar(value);
  if (!text) return null;
  const cleaned = decodeEntities(text.replace(/<[^>]*>/g, ' '))
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, 500) : null;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(
        entity.slice(entity[1]?.toLowerCase() === 'x' ? 2 : 1),
        entity[1]?.toLowerCase() === 'x' ? 16 : 10,
      );
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : whole;
    }
    return named[entity.toLowerCase()] ?? whole;
  });
}

function normalizePortalDate(value: unknown): string | null {
  const raw = scalar(value);
  if (!raw || !/^\d{8}$/.test(raw)) return null;
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return isIsoDate(iso) ? iso : null;
}

function normalizePortalTime(value: unknown): string | null {
  let raw = scalar(value)?.trim() ?? '';
  if (!raw) return null;
  if (/^\d{3}$/.test(raw)) raw = `0${raw}`;
  if (!/^\d{4}$/.test(raw)) return null;
  const hour = Number(raw.slice(0, 2));
  const minute = Number(raw.slice(2));
  if (hour > 23 || minute > 59) return null;
  return `${raw.slice(0, 2)}:${raw.slice(2)}`;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
