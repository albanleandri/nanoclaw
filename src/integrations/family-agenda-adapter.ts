import { HostIntegrationOperationError } from './invoker.js';
import { normalizeAgenda, type FamilyAgendaEvent, type FamilyAgendaResult } from './family-agenda.js';
import type {
  HostIntegrationAdapter,
  HostIntegrationDestination,
  HostIntegrationOperation,
  HostIntegrationOperationContext,
  HostIntegrationResponseLimits,
} from './types.js';

const ORIGIN = 'https://www.espace-citoyens.net';
const REQUEST_DEADLINE_MS = 8_000;
const TOTAL_DEADLINE_MS = 25_000;
const MAX_COOKIES = 32;
const MAX_EVENTS = 5_000;
const MAX_RETRY_AFTER_MS = 1_000;

export interface FamilyAgendaAdapterConfig {
  tenant: string;
}

export interface FamilyAgendaProtectedPayload {
  username: string;
  password: string;
  personId: string;
}

export interface FamilyAgendaAdapterInput {
  from: string;
  days: number;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const RESPONSE_LIMITS: HostIntegrationResponseLimits = Object.freeze({
  maxHeaderBytes: 32 * 1024,
  maxCookieBytes: 8 * 1024,
  maxBodyBytes: 2 * 1024 * 1024,
  maxNormalizedOutputBytes: 256 * 1024,
});

const DESTINATION: HostIntegrationDestination<FamilyAgendaAdapterConfig> = Object.freeze({
  origin: ORIGIN,
  methods: Object.freeze(['GET', 'POST'] as const),
  isAllowedUrl: (url: URL, config: FamilyAgendaAdapterConfig) => isAllowedUrl(url, config),
});

const NETWORK = Object.freeze({
  destinations: Object.freeze([DESTINATION]),
  maxRedirects: 3,
});

export function createFamilyAgendaAdapter(
  fetchImpl: FetchLike = fetch,
): HostIntegrationAdapter<FamilyAgendaAdapterConfig, FamilyAgendaProtectedPayload> {
  const operation: HostIntegrationOperation<FamilyAgendaAdapterConfig, FamilyAgendaProtectedPayload> = Object.freeze({
    name: 'agenda.read',
    sideEffects: 'none',
    validateInput: validateInput,
    validateOutput: validateOutput,
    totalDeadlineMs: TOTAL_DEADLINE_MS,
    network: NETWORK,
    responseLimits: RESPONSE_LIMITS,
    execute: async ({
      config,
      protectedPayload,
      input,
      signal,
    }: HostIntegrationOperationContext<FamilyAgendaAdapterConfig, FamilyAgendaProtectedPayload>) =>
      executeAgenda(config, protectedPayload, validateInput(input), signal, fetchImpl, operation),
  });

  return {
    id: 'family-agenda',
    version: 1,
    securityTier: 'trusted-host',
    hostAuthJustification:
      'The portal requires an HTML form login and a host-owned cookie session that OneCLI cannot inject safely.',
    validateConfig,
    validateProtectedPayload,
    protectedFields: [
      { name: 'username', sensitivity: 'private', label: 'Portal username' },
      { name: 'password', sensitivity: 'secret', label: 'Portal password' },
      { name: 'personId', sensitivity: 'private', label: 'Portal person selector' },
    ],
    operations: { 'agenda.read': operation },
  };
}

export const familyAgendaAdapter = createFamilyAgendaAdapter();

function validateConfig(value: unknown): FamilyAgendaAdapterConfig {
  const record = exactRecord(value, ['tenant']);
  const tenant = requiredString(record.tenant, true);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(tenant)) throw invalidConfiguration();
  return { tenant };
}

function validateProtectedPayload(value: unknown): FamilyAgendaProtectedPayload {
  const record = exactRecord(value, ['username', 'password', 'personId']);
  const username = requiredString(record.username, true);
  const password = requiredString(record.password, false);
  const personId = requiredString(record.personId, true);
  if (!/^\d+$/.test(personId)) throw invalidConfiguration();
  return { username, password, personId };
}

function validateInput(value: unknown): FamilyAgendaAdapterInput {
  const record = exactRecord(value, ['from', 'days']);
  if (typeof record.from !== 'string' || !isIsoDate(record.from)) throw invalidConfiguration();
  if (typeof record.days !== 'number' || !Number.isInteger(record.days) || record.days < 1 || record.days > 31) {
    throw invalidConfiguration();
  }
  return { from: record.from, days: record.days };
}

function validateOutput(value: unknown): FamilyAgendaResult {
  const record = exactRecord(value, ['from', 'through', 'events'], contractChanged);
  if (typeof record.from !== 'string' || !isIsoDate(record.from)) throw contractChanged();
  if (typeof record.through !== 'string' || !isIsoDate(record.through) || record.through < record.from) {
    throw contractChanged();
  }
  if (!Array.isArray(record.events) || record.events.length > MAX_EVENTS) throw contractChanged();
  return {
    from: record.from,
    through: record.through,
    events: record.events.map(validateEvent),
  };
}

function validateEvent(value: unknown): FamilyAgendaEvent {
  const record = exactRecord(
    value,
    ['date', 'start', 'end', 'title', 'activity', 'location', 'detail'],
    contractChanged,
  );
  if (typeof record.date !== 'string' || !isIsoDate(record.date)) throw contractChanged();
  const start = nullableTime(record.start);
  const end = nullableTime(record.end);
  const title = boundedText(record.title, false);
  return {
    date: record.date,
    start,
    end,
    title,
    activity: boundedText(record.activity, true),
    location: boundedText(record.location, true),
    detail: boundedText(record.detail, true),
  };
}

async function executeAgenda(
  config: FamilyAgendaAdapterConfig,
  protectedPayload: FamilyAgendaProtectedPayload,
  input: FamilyAgendaAdapterInput,
  signal: AbortSignal,
  fetchImpl: FetchLike,
  operation: HostIntegrationOperation<FamilyAgendaAdapterConfig, FamilyAgendaProtectedPayload>,
): Promise<FamilyAgendaResult> {
  const portalRoot = `/${config.tenant}/espace-citoyens`;
  const detailUrl = new URL(`${portalRoot}/FichePersonne/DetailPersonne`, ORIGIN);
  detailUrl.searchParams.set('idDynamic', protectedPayload.personId);
  const calendarUrl = new URL(`${portalRoot}/FichePersonne/DetailPersonneGetCalendrier`, ORIGIN);
  calendarUrl.searchParams.set('idDynamic', protectedPayload.personId);
  const cookies = new CookieJar(operation.responseLimits.maxCookieBytes);

  const request = (url: URL, init: RequestInit = {}, allowRedirect = false) =>
    requestBounded({
      url,
      init,
      allowRedirect,
      config,
      signal,
      fetchImpl,
      operation,
      cookies,
    });

  const landing = await request(new URL(`${portalRoot}/`, ORIGIN), { headers: { accept: 'text/html' } });
  requireContentType(landing, 'text/html', false);

  const modal = await request(new URL(`${portalRoot}/Home/RecupererModaleConnexion`, ORIGIN), {
    method: 'POST',
    headers: { accept: 'text/html', 'x-requested-with': 'XMLHttpRequest' },
  });
  requireContentType(modal, 'text/html', false);

  const form = new URLSearchParams({
    username: protectedPayload.username,
    password: protectedPayload.password,
    returnUrl: '',
  });
  const login = await request(new URL(`${portalRoot}/Home/LogonAjax`, ORIGIN), {
    method: 'POST',
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
    },
    body: form,
  });
  const loginRecord = jsonRecord(login, false);
  const loginStatus = String(loginRecord.Status ?? loginRecord.status ?? '');
  if (loginStatus.toUpperCase() !== 'OK') throw authenticationRejected();

  const locationValue = loginRecord.locationHref ?? loginRecord.LocationHref;
  const loginUrl =
    locationValue === undefined || locationValue === null || locationValue === ''
      ? new URL(`${portalRoot}/`, ORIGIN)
      : allowedRedirectUrl(locationValue, config, operation);
  const landedUrl = await navigate(loginUrl, request, config, operation);
  if (landedUrl.toString() !== detailUrl.toString()) {
    const detail = await request(detailUrl, { headers: { accept: 'text/html' } });
    requireContentType(detail, 'text/html', false);
  }

  const calendar = await request(calendarUrl, {
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      referer: detailUrl.toString(),
      'x-requested-with': 'XMLHttpRequest',
    },
  });
  const payload = jsonValue(calendar, true);
  const through = addDays(input.from, input.days - 1);
  const result: FamilyAgendaResult = {
    from: input.from,
    through,
    events: normalizeAgendaSafely(payload).filter((event) => event.date >= input.from && event.date <= through),
  };
  return validateOutput(result);
}

interface BoundedRequestOptions {
  url: URL;
  init: RequestInit;
  allowRedirect: boolean;
  config: FamilyAgendaAdapterConfig;
  signal: AbortSignal;
  fetchImpl: FetchLike;
  operation: HostIntegrationOperation<FamilyAgendaAdapterConfig, FamilyAgendaProtectedPayload>;
  cookies: CookieJar;
}

interface BoundedResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

async function requestBounded(options: BoundedRequestOptions): Promise<BoundedResponse> {
  const method = normalizedMethod(options.init.method);
  assertAllowedRequest(options.url, method, options.config, options.operation);
  const maxAttempts = method === 'GET' ? 2 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let response: BoundedResponse;
    try {
      response = await singleRequest(options, method);
    } catch (error) {
      if (error instanceof HostIntegrationOperationError) throw error;
      if (options.signal.aborted) throw error;
      if (error instanceof TransientNetworkFailure && attempt + 1 < maxAttempts) continue;
      throw upstreamTransient();
    }

    if (isTransientStatus(response.status) && attempt + 1 < maxAttempts) {
      await waitForRetry(response.headers.get('retry-after'), options.signal);
      continue;
    }

    options.cookies.remember(response.headers);
    if (response.status >= 300 && response.status < 400) {
      if (options.allowRedirect) return response;
      throw contractChanged();
    }
    if (response.status === 401 || response.status === 403) throw authenticationRejected();
    if (response.status === 429 || response.status >= 500) throw upstreamTransient();
    if (response.status < 200 || response.status >= 300) throw contractChanged();
    return response;
  }
  throw upstreamTransient();
}

async function singleRequest(options: BoundedRequestOptions, method: 'GET' | 'POST'): Promise<BoundedResponse> {
  if (options.signal.aborted) throw new Error('Invocation aborted');
  const controller = new AbortController();
  let requestTimedOut = false;
  const onInvocationAbort = () => controller.abort();
  options.signal.addEventListener('abort', onInvocationAbort, { once: true });
  const timer = setTimeout(() => {
    requestTimedOut = true;
    controller.abort();
  }, REQUEST_DEADLINE_MS);

  try {
    const headers = new Headers(options.init.headers);
    const cookieHeader = options.cookies.header();
    if (cookieHeader) headers.set('cookie', cookieHeader);
    const response = await options.fetchImpl(options.url, {
      ...options.init,
      method,
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });
    requireBoundedHeaders(response.headers, options.operation.responseLimits.maxHeaderBytes);
    const body = await readBoundedBody(response, options.operation.responseLimits.maxBodyBytes);
    return { status: response.status, headers: response.headers, body };
  } catch (error) {
    if (error instanceof HostIntegrationOperationError) throw error;
    if (requestTimedOut) throw upstreamTimeout();
    if (options.signal.aborted) throw error;
    throw new TransientNetworkFailure();
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onInvocationAbort);
  }
}

async function navigate(
  initialUrl: URL,
  request: (url: URL, init?: RequestInit, allowRedirect?: boolean) => Promise<BoundedResponse>,
  config: FamilyAgendaAdapterConfig,
  operation: HostIntegrationOperation<FamilyAgendaAdapterConfig, FamilyAgendaProtectedPayload>,
): Promise<URL> {
  let url = initialUrl;
  for (let redirects = 0; redirects <= operation.network.maxRedirects; redirects++) {
    const response = await request(url, { headers: { accept: 'text/html' } }, true);
    if (response.status < 300 || response.status >= 400) {
      requireContentType(response, 'text/html', false);
      return url;
    }
    if (redirects === operation.network.maxRedirects) throw contractChanged();
    const location = response.headers.get('location');
    if (!location) throw contractChanged();
    url = allowedRedirectUrl(location, config, operation);
  }
  throw contractChanged();
}

function allowedRedirectUrl(
  location: unknown,
  config: FamilyAgendaAdapterConfig,
  operation: HostIntegrationOperation<FamilyAgendaAdapterConfig, FamilyAgendaProtectedPayload>,
): URL {
  if (typeof location !== 'string' || !location.trim()) throw contractChanged();
  let url: URL;
  try {
    url = new URL(location, ORIGIN);
  } catch {
    throw contractChanged();
  }
  assertAllowedRequest(url, 'GET', config, operation);
  const root = `/${config.tenant}/espace-citoyens`;
  if (url.search || (url.pathname !== `${root}/` && url.pathname !== `${root}/CompteCitoyen`)) {
    throw contractChanged();
  }
  return url;
}

function assertAllowedRequest(
  url: URL,
  method: 'GET' | 'POST',
  config: FamilyAgendaAdapterConfig,
  operation: HostIntegrationOperation<FamilyAgendaAdapterConfig, FamilyAgendaProtectedPayload>,
): void {
  const destination = operation.network.destinations.find((candidate) => candidate.origin === url.origin);
  if (!destination || !destination.methods.includes(method) || !destination.isAllowedUrl(url, config)) {
    throw contractChanged();
  }
  const root = `/${config.tenant}/espace-citoyens`;
  const exactMethod =
    (method === 'GET' &&
      (url.pathname === `${root}/` ||
        url.pathname === `${root}/CompteCitoyen` ||
        url.pathname === `${root}/FichePersonne/DetailPersonne` ||
        url.pathname === `${root}/FichePersonne/DetailPersonneGetCalendrier`)) ||
    (method === 'POST' &&
      (url.pathname === `${root}/Home/RecupererModaleConnexion` || url.pathname === `${root}/Home/LogonAjax`));
  if (!exactMethod) throw contractChanged();
}

function isAllowedUrl(url: URL, config: FamilyAgendaAdapterConfig): boolean {
  if (url.origin !== ORIGIN || url.username || url.password || url.hash) return false;
  const root = `/${config.tenant}/espace-citoyens`;
  if (
    url.pathname === `${root}/` ||
    url.pathname === `${root}/CompteCitoyen` ||
    url.pathname === `${root}/Home/RecupererModaleConnexion` ||
    url.pathname === `${root}/Home/LogonAjax`
  ) {
    return url.search === '';
  }
  if (
    url.pathname !== `${root}/FichePersonne/DetailPersonne` &&
    url.pathname !== `${root}/FichePersonne/DetailPersonneGetCalendrier`
  ) {
    return false;
  }
  const entries = [...url.searchParams.entries()];
  return entries.length === 1 && entries[0]?.[0] === 'idDynamic' && /^\d+$/.test(entries[0][1]);
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw contractChanged();
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function requireBoundedHeaders(headers: Headers, limit: number): void {
  let size = 0;
  headers.forEach((value, name) => {
    size += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8') + 4;
  });
  if (size > limit) throw contractChanged();
}

class CookieJar {
  private readonly values = new Map<string, string>();

  constructor(private readonly maxBytes: number) {}

  remember(headers: Headers): void {
    const extended = headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = extended.getSetCookie?.() ?? (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
    let responseBytes = 0;
    for (const setCookie of setCookies) {
      responseBytes += Buffer.byteLength(setCookie, 'utf8');
      if (responseBytes > this.maxBytes) throw contractChanged();
      const pair = setCookie.split(';', 1)[0] ?? '';
      const equals = pair.indexOf('=');
      if (equals <= 0) throw contractChanged();
      const name = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1).trim();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || hasControlCharacter(value)) {
        throw contractChanged();
      }
      this.values.set(name, value);
      if (this.values.size > MAX_COOKIES || Buffer.byteLength(this.header(), 'utf8') > this.maxBytes) {
        throw contractChanged();
      }
    }
  }

  header(): string {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

function requireContentType(response: BoundedResponse, type: string, loginFallback: boolean): void {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes(type)) {
    if (loginFallback && contentType.includes('text/html')) throw authenticationRejected();
    throw contractChanged();
  }
}

function jsonRecord(response: BoundedResponse, loginFallback: boolean): Record<string, unknown> {
  const value = jsonValue(response, loginFallback);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw contractChanged();
  return value as Record<string, unknown>;
}

function jsonValue(response: BoundedResponse, loginFallback: boolean): unknown {
  requireContentType(response, 'json', loginFallback);
  try {
    return JSON.parse(decodeBody(response.body)) as unknown;
  } catch (error) {
    if (error instanceof HostIntegrationOperationError) throw error;
    throw contractChanged();
  }
}

function decodeBody(body: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw contractChanged();
  }
}

function normalizeAgendaSafely(payload: unknown): FamilyAgendaEvent[] {
  try {
    return normalizeAgenda(payload);
  } catch {
    throw contractChanged();
  }
}

async function waitForRetry(value: string | null, signal: AbortSignal): Promise<void> {
  const seconds = value && /^\d+$/.test(value.trim()) ? Number(value.trim()) : 0;
  const delayMs = Math.min(Number.isSafeInteger(seconds) ? seconds * 1_000 : 0, MAX_RETRY_AFTER_MS);
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('Invocation aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function normalizedMethod(value: string | undefined): 'GET' | 'POST' {
  const method = (value ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') throw contractChanged();
  return method;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  failureFactory: () => Error = invalidConfiguration,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failureFactory();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) throw failureFactory();
  const actual = (ownKeys as string[]).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw failureFactory();
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, trim: boolean): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 4_096) {
    throw invalidConfiguration();
  }
  return trim ? value.trim() : value;
}

function nullableTime(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw contractChanged();
  return value;
}

function boundedText(value: unknown, nullable: false): string;
function boundedText(value: unknown, nullable: true): string | null;
function boundedText(value: unknown, nullable: boolean): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value || value.length > 500) throw contractChanged();
  return value;
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

function isTransientStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

class TransientNetworkFailure extends Error {}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function invalidConfiguration(): Error {
  return new Error('Family agenda value is invalid');
}

function authenticationRejected(): HostIntegrationOperationError {
  return new HostIntegrationOperationError('authentication_rejected');
}

function upstreamTimeout(): HostIntegrationOperationError {
  return new HostIntegrationOperationError('upstream_timeout');
}

function upstreamTransient(): HostIntegrationOperationError {
  return new HostIntegrationOperationError('upstream_transient');
}

function contractChanged(): HostIntegrationOperationError {
  return new HostIntegrationOperationError('upstream_contract_changed');
}
