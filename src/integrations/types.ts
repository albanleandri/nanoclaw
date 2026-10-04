export type HostIntegrationSecurityTier = 'trusted-host';
export type HostIntegrationSideEffects = 'none';
export type ProtectedFieldSensitivity = 'secret' | 'private';
export type HostIntegrationHttpMethod = 'GET' | 'POST';

export interface ProtectedField {
  /** Top-level key returned by validateProtectedPayload. */
  name: string;
  sensitivity: ProtectedFieldSensitivity;
  /** Safe operator-facing label. It must not contain a credential value. */
  label: string;
}

export interface HostIntegrationDestination<Config> {
  /** Exact HTTPS origin, including a non-default port when one is required. */
  origin: string;
  methods: readonly HostIntegrationHttpMethod[];
  /** Adapter-owned path/query allowlist applied before each request. */
  isAllowedUrl(url: URL, config: Config): boolean;
}

export interface HostIntegrationNetworkPolicy<Config> {
  destinations: readonly HostIntegrationDestination<Config>[];
  maxRedirects: number;
  /** Per-request bound inside the whole-operation deadline. */
  requestDeadlineMs: number;
  maxCookies: number;
  retry: {
    /** Only idempotent methods may be declared retryable. */
    methods: readonly HostIntegrationHttpMethod[];
    statuses: readonly number[];
    maxAttempts: number;
    maxRetryAfterMs: number;
  };
}

export interface HostIntegrationResponseLimits {
  maxHeaderBytes: number;
  maxCookieBytes: number;
  maxBodyBytes: number;
  maxNormalizedOutputBytes: number;
}

export interface HostIntegrationOperationContext<Config, ProtectedPayload> {
  config: Config;
  protectedPayload: ProtectedPayload;
  input: unknown;
  /** Adapter I/O must use this signal and stop promptly when it aborts. */
  signal: AbortSignal;
}

export interface HostIntegrationOperation<Config, ProtectedPayload> {
  name: string;
  sideEffects: HostIntegrationSideEffects;
  validateInput(value: unknown): unknown;
  validateOutput(value: unknown): unknown;
  totalDeadlineMs: number;
  network: HostIntegrationNetworkPolicy<Config>;
  responseLimits: HostIntegrationResponseLimits;
  execute(context: HostIntegrationOperationContext<Config, ProtectedPayload>): Promise<unknown>;
}

export interface HostIntegrationAdapter<
  Config extends object = Record<string, unknown>,
  ProtectedPayload extends object = Record<string, unknown>,
> {
  id: string;
  version: number;
  securityTier: HostIntegrationSecurityTier;
  hostAuthJustification: string;
  validateConfig(value: unknown): Config;
  validateProtectedPayload(value: unknown): ProtectedPayload;
  protectedFields: readonly ProtectedField[];
  operations: Readonly<Record<string, HostIntegrationOperation<Config, ProtectedPayload>>>;
}

export type HostIntegrationAdapterLike = HostIntegrationAdapter<Record<string, unknown>, Record<string, unknown>>;
