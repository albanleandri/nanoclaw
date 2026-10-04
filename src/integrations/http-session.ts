import { HostIntegrationOperationError } from './invoker.js';
import type { HostIntegrationHttpMethod, HostIntegrationOperation } from './types.js';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type HostHttpHeaders = ConstructorParameters<typeof Headers>[0];

export interface BoundedHostHttpSessionOptions<Config extends object> {
  config: Config;
  operation: Pick<HostIntegrationOperation<Config, object>, 'network' | 'responseLimits'>;
  signal: AbortSignal;
  /** Test seam. Production plugins use the host's native fetch. */
  fetchImpl?: FetchLike;
}

export interface BoundedHostHttpRequest {
  url: URL;
  method?: HostIntegrationHttpMethod;
  headers?: HostHttpHeaders;
  body?: string | URLSearchParams;
  /** Lowercase media-type fragments accepted for a successful response. */
  acceptedContentTypes: readonly string[];
  /** Used only by followRedirects(). Ordinary requests reject redirects. */
  allowRedirectResponse?: boolean;
}

export interface BoundedHostHttpResponse {
  url: URL;
  status: number;
  headers: Headers;
  body: Uint8Array;
  text(): string;
  json(): unknown;
}

export interface FollowRedirectOptions extends Omit<
  BoundedHostHttpRequest,
  'url' | 'method' | 'allowRedirectResponse'
> {
  /** Optional plugin-owned restriction in addition to the registered URL policy. */
  validateRedirect?: (from: URL, to: URL, status: number) => boolean;
}

export class BoundedHostHttpSession<Config extends object> {
  private readonly cookies = new Map<string, { origin: string; name: string; value: string }>();
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: BoundedHostHttpSessionOptions<Config>) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(request: BoundedHostHttpRequest): Promise<BoundedHostHttpResponse> {
    const method = request.method ?? 'GET';
    this.assertRequest(request.url, method);
    const acceptedContentTypes = validateContentTypes(request.acceptedContentTypes);
    const retry = this.options.operation.network.retry;
    const attempts = retry.methods.includes(method) ? retry.maxAttempts : 1;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      let response: BoundedHostHttpResponse;
      try {
        response = await this.singleRequest(request, method);
      } catch (error) {
        if (error instanceof HostIntegrationOperationError) throw error;
        if (this.options.signal.aborted) throw error;
        if (attempt < attempts) continue;
        throw operationError('upstream_transient');
      }

      if (retry.statuses.includes(response.status) && attempt < attempts) {
        await waitForRetry(response.headers.get('retry-after'), retry.maxRetryAfterMs, this.options.signal);
        continue;
      }

      this.rememberCookies(response.url, response.headers);
      if (response.status >= 300 && response.status < 400) {
        if (request.allowRedirectResponse) return response;
        throw operationError('upstream_contract_changed');
      }
      if (response.status === 401 || response.status === 403) throw operationError('authentication_rejected');
      if (response.status === 429 || response.status >= 500) throw operationError('upstream_transient');
      if (response.status < 200 || response.status >= 300) throw operationError('upstream_contract_changed');

      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!acceptedContentTypes.some((accepted) => contentType.includes(accepted))) {
        throw operationError('upstream_contract_changed');
      }
      return response;
    }
    throw operationError('upstream_transient');
  }

  async followRedirects(initialUrl: URL, options: FollowRedirectOptions): Promise<BoundedHostHttpResponse> {
    let url = initialUrl;
    for (let count = 0; count <= this.options.operation.network.maxRedirects; count++) {
      const response = await this.request({
        ...options,
        url,
        method: 'GET',
        allowRedirectResponse: true,
      });
      if (response.status < 300 || response.status >= 400) return response;
      if (count === this.options.operation.network.maxRedirects) {
        throw operationError('upstream_contract_changed');
      }
      const location = response.headers.get('location');
      if (!location) throw operationError('upstream_contract_changed');
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw operationError('upstream_contract_changed');
      }
      this.assertRequest(next, 'GET');
      if (options.validateRedirect && !options.validateRedirect(url, next, response.status)) {
        throw operationError('upstream_contract_changed');
      }
      url = next;
    }
    throw operationError('upstream_contract_changed');
  }

  private async singleRequest(
    request: BoundedHostHttpRequest,
    method: HostIntegrationHttpMethod,
  ): Promise<BoundedHostHttpResponse> {
    if (this.options.signal.aborted) throw new Error('Invocation aborted');
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    this.options.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.operation.network.requestDeadlineMs);

    try {
      const headers = new Headers(request.headers);
      const cookie = this.cookieHeader(request.url.origin);
      if (cookie) headers.set('cookie', cookie);
      const body = normalizeRequestBody(request.body, this.options.operation.responseLimits.maxBodyBytes);
      requireBoundedHeaders(headers, this.options.operation.responseLimits.maxHeaderBytes);
      const response = await this.fetchImpl(request.url, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      });
      requireBoundedHeaders(response.headers, this.options.operation.responseLimits.maxHeaderBytes);
      const responseBody = await readBoundedBody(response, this.options.operation.responseLimits.maxBodyBytes);
      return responseValue(request.url, response.status, response.headers, responseBody);
    } catch (error) {
      if (error instanceof HostIntegrationOperationError) throw error;
      if (timedOut) throw operationError('upstream_timeout');
      if (this.options.signal.aborted) throw error;
      throw error;
    } finally {
      clearTimeout(timer);
      this.options.signal.removeEventListener('abort', onAbort);
    }
  }

  private assertRequest(url: URL, method: HostIntegrationHttpMethod): void {
    const destination = this.options.operation.network.destinations.find(
      (candidate) => candidate.origin === url.origin,
    );
    if (!destination || !destination.methods.includes(method) || !destination.isAllowedUrl(url, this.options.config)) {
      throw operationError('upstream_contract_changed');
    }
  }

  private rememberCookies(url: URL, headers: Headers): void {
    const limits = this.options.operation.responseLimits;
    const extended = headers as Headers & { getSetCookie?: () => string[] };
    const values = extended.getSetCookie?.() ?? (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
    let responseBytes = 0;
    for (const value of values) {
      responseBytes += Buffer.byteLength(value, 'utf8');
      if (responseBytes > limits.maxCookieBytes) throw operationError('upstream_contract_changed');
      const pair = value.split(';', 1)[0] ?? '';
      const equals = pair.indexOf('=');
      if (equals <= 0) throw operationError('upstream_contract_changed');
      const name = pair.slice(0, equals).trim();
      const cookieValue = pair.slice(equals + 1).trim();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || hasControlCharacter(cookieValue)) {
        throw operationError('upstream_contract_changed');
      }
      this.cookies.set(`${url.origin}\0${name}`, { origin: url.origin, name, value: cookieValue });
      if (
        this.cookies.size > this.options.operation.network.maxCookies ||
        this.cookieStoreBytes() > limits.maxCookieBytes
      ) {
        throw operationError('upstream_contract_changed');
      }
    }
  }

  private cookieHeader(origin: string): string {
    return [...this.cookies.values()]
      .filter((cookie) => cookie.origin === origin)
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
  }

  private cookieStoreBytes(): number {
    return [...this.cookies.values()].reduce(
      (total, cookie) => total + Buffer.byteLength(`${cookie.name}=${cookie.value}; `, 'utf8'),
      0,
    );
  }
}

export function createBoundedHostHttpSession<Config extends object>(
  options: BoundedHostHttpSessionOptions<Config>,
): BoundedHostHttpSession<Config> {
  return new BoundedHostHttpSession(options);
}

function responseValue(url: URL, status: number, headers: Headers, body: Uint8Array): BoundedHostHttpResponse {
  return {
    url,
    status,
    headers,
    body,
    text: () => decodeBody(body),
    json: () => {
      try {
        return JSON.parse(decodeBody(body)) as unknown;
      } catch (error) {
        if (error instanceof HostIntegrationOperationError) throw error;
        throw operationError('upstream_contract_changed');
      }
    },
  };
}

function validateContentTypes(values: readonly string[]): string[] {
  if (values.length === 0 || values.some((value) => !value || value !== value.toLowerCase())) {
    throw operationError('invalid_configuration');
  }
  return [...new Set(values)];
}

function normalizeRequestBody(value: BoundedHostHttpRequest['body'], limit: number): RequestInit['body'] {
  if (value === undefined) return undefined;
  const body = value instanceof URLSearchParams ? value.toString() : value;
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > limit) throw operationError('upstream_contract_changed');
  return body;
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
        throw operationError('upstream_contract_changed');
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
  if (size > limit) throw operationError('upstream_contract_changed');
}

function decodeBody(body: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw operationError('upstream_contract_changed');
  }
}

async function waitForRetry(value: string | null, maximumMs: number, signal: AbortSignal): Promise<void> {
  const seconds = value && /^\d+$/.test(value.trim()) ? Number(value.trim()) : 0;
  const delay = Math.min(Number.isSafeInteger(seconds) ? seconds * 1_000 : 0, maximumMs);
  if (delay <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, delay);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('Invocation aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function operationError(resultClass: ConstructorParameters<typeof HostIntegrationOperationError>[0]) {
  return new HostIntegrationOperationError(resultClass);
}
