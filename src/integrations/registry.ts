import { validateProtectedFieldDeclarations } from './protected-payload.js';
import type {
  HostIntegrationAdapter,
  HostIntegrationAdapterLike,
  HostIntegrationDestination,
  HostIntegrationOperation,
} from './types.js';

const ADAPTER_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const OPERATION_NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const MAX_TOTAL_DEADLINE_MS = 5 * 60_000;
const MAX_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const MAX_COOKIES = 128;
const MAX_RETRY_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 30_000;
const RESPONSE_LIMIT_NAMES = ['maxHeaderBytes', 'maxCookieBytes', 'maxBodyBytes', 'maxNormalizedOutputBytes'] as const;

export interface HostIntegrationRegistry {
  register<Config extends object, ProtectedPayload extends object>(
    adapter: HostIntegrationAdapter<Config, ProtectedPayload>,
  ): void;
  get(id: string, version: number): HostIntegrationAdapterLike | undefined;
  require(id: string, version: number): HostIntegrationAdapterLike;
  requireOperation(id: string, version: number, operation: string): HostIntegrationOperation<object, object>;
  list(): HostIntegrationAdapterLike[];
}

export function createHostIntegrationRegistry(): HostIntegrationRegistry {
  const adapters = new Map<string, HostIntegrationAdapterLike>();
  const registry: HostIntegrationRegistry = {
    register(adapter) {
      validateHostIntegrationAdapter(adapter);
      const key = adapterKey(adapter.id, adapter.version);
      if (adapters.has(key)) {
        throw new Error(`Host integration adapter already registered: ${adapter.id}@${adapter.version}`);
      }
      adapters.set(key, snapshotAdapter(adapter));
    },
    get: (id, version) => adapters.get(adapterKey(id.trim().toLowerCase(), version)),
    require: (id, version) => {
      const adapter = adapters.get(adapterKey(id.trim().toLowerCase(), version));
      if (!adapter) throw new Error(`Unknown host integration adapter: ${id}@${version}`);
      return adapter;
    },
    requireOperation: (id, version, operation) => {
      const adapter = adapters.get(adapterKey(id.trim().toLowerCase(), version));
      if (!adapter) throw new Error(`Unknown host integration adapter: ${id}@${version}`);
      if (!Object.prototype.hasOwnProperty.call(adapter.operations, operation)) {
        throw new Error(`Unknown host integration operation: ${id}@${version}.${operation}`);
      }
      const registeredOperation = adapter.operations[operation]!;
      return registeredOperation as unknown as HostIntegrationOperation<object, object>;
    },
    list: () => [...adapters.values()].sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version),
  };
  return registry;
}

export function validateHostIntegrationAdapter<Config extends object, ProtectedPayload extends object>(
  adapter: HostIntegrationAdapter<Config, ProtectedPayload>,
): void {
  if (!ADAPTER_ID.test(adapter.id)) {
    throw new Error(`Host integration adapter id must be kebab-case lowercase: ${adapter.id || '(empty)'}`);
  }
  if (!Number.isInteger(adapter.version) || adapter.version < 1) {
    throw new Error(`Host integration adapter ${adapter.id} must declare a positive integer version`);
  }
  if (adapter.securityTier !== 'trusted-host') {
    throw new Error(`Host integration adapter ${adapter.id} must use the trusted-host security tier`);
  }
  if (!adapter.hostAuthJustification.trim()) {
    throw new Error(`Host integration adapter ${adapter.id} must justify host-owned authentication`);
  }
  if (typeof adapter.validateConfig !== 'function' || typeof adapter.validateProtectedPayload !== 'function') {
    throw new Error(`Host integration adapter ${adapter.id} must provide config and protected-payload validators`);
  }
  validateProtectedFieldDeclarations(adapter.protectedFields);

  const operations = Object.entries(adapter.operations);
  if (operations.length === 0) throw new Error(`Host integration adapter ${adapter.id} has no operations`);
  for (const [key, operation] of operations) validateOperation(adapter.id, key, operation);
}

function validateOperation<Config extends object, ProtectedPayload extends object>(
  adapterId: string,
  key: string,
  operation: HostIntegrationOperation<Config, ProtectedPayload>,
): void {
  if (!OPERATION_NAME.test(key) || operation.name !== key) {
    throw new Error(`Host integration adapter ${adapterId} has an invalid or mismatched operation name: ${key}`);
  }
  if (operation.sideEffects !== 'none') {
    throw new Error(`Host integration operation ${adapterId}.${key} must be read-only in v1`);
  }
  if (
    typeof operation.validateInput !== 'function' ||
    typeof operation.validateOutput !== 'function' ||
    typeof operation.execute !== 'function'
  ) {
    throw new Error(`Host integration operation ${adapterId}.${key} is missing validation or execution code`);
  }
  requirePositiveInteger(operation.totalDeadlineMs, `${adapterId}.${key} total deadline`, MAX_TOTAL_DEADLINE_MS);
  requireNonNegativeInteger(operation.network.maxRedirects, `${adapterId}.${key} redirect limit`, MAX_REDIRECTS);
  requirePositiveInteger(
    operation.network.requestDeadlineMs,
    `${adapterId}.${key} request deadline`,
    operation.totalDeadlineMs,
  );
  requirePositiveInteger(operation.network.maxCookies, `${adapterId}.${key} cookie limit`, MAX_COOKIES);
  validateRetryPolicy(adapterId, key, operation.network.retry);
  if (operation.network.destinations.length === 0) {
    throw new Error(`Host integration operation ${adapterId}.${key} must declare a network destination`);
  }
  const origins = new Set<string>();
  for (const destination of operation.network.destinations) {
    validateDestination(adapterId, key, destination);
    if (origins.has(destination.origin)) {
      throw new Error(`Host integration operation ${adapterId}.${key} declares a duplicate origin`);
    }
    origins.add(destination.origin);
  }
  const limitKeys = Object.keys(operation.responseLimits).sort();
  if (limitKeys.join('\0') !== [...RESPONSE_LIMIT_NAMES].sort().join('\0')) {
    throw new Error(`Host integration operation ${adapterId}.${key} must declare the exact response limits`);
  }
  for (const name of RESPONSE_LIMIT_NAMES) {
    requirePositiveInteger(operation.responseLimits[name], `${adapterId}.${key} ${name}`, MAX_RESPONSE_LIMIT_BYTES);
  }
}

function validateRetryPolicy(
  adapterId: string,
  operationName: string,
  retry: HostIntegrationOperation<object, object>['network']['retry'],
): void {
  if (!retry || typeof retry !== 'object') {
    throw new Error(`Host integration operation ${adapterId}.${operationName} must declare a retry policy`);
  }
  if (retry.methods.some((method) => method !== 'GET') || new Set(retry.methods).size !== retry.methods.length) {
    throw new Error(`Host integration operation ${adapterId}.${operationName} may retry only idempotent GET requests`);
  }
  if (
    retry.statuses.some((status) => ![502, 503, 504].includes(status)) ||
    new Set(retry.statuses).size !== retry.statuses.length
  ) {
    throw new Error(`Host integration operation ${adapterId}.${operationName} has invalid retry statuses`);
  }
  requirePositiveInteger(retry.maxAttempts, `${adapterId}.${operationName} retry attempts`, MAX_RETRY_ATTEMPTS);
  requireNonNegativeInteger(
    retry.maxRetryAfterMs,
    `${adapterId}.${operationName} retry-after limit`,
    MAX_RETRY_AFTER_MS,
  );
  if (retry.methods.length === 0 && retry.maxAttempts !== 1) {
    throw new Error(`Host integration operation ${adapterId}.${operationName} cannot retry without a method`);
  }
}

function validateDestination<Config extends object>(
  adapterId: string,
  operationName: string,
  destination: HostIntegrationDestination<Config>,
): void {
  let url: URL;
  try {
    url = new URL(destination.origin);
  } catch (error) {
    throw new Error(`Host integration operation ${adapterId}.${operationName} has an invalid origin`, {
      cause: error,
    });
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== destination.origin ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(`Host integration operation ${adapterId}.${operationName} must use an exact HTTPS origin`);
  }
  if (destination.methods.length === 0 || destination.methods.some((method) => method !== 'GET' && method !== 'POST')) {
    throw new Error(`Host integration operation ${adapterId}.${operationName} has invalid allowed methods`);
  }
  if (new Set(destination.methods).size !== destination.methods.length) {
    throw new Error(`Host integration operation ${adapterId}.${operationName} declares a duplicate method`);
  }
  if (typeof destination.isAllowedUrl !== 'function') {
    throw new Error(`Host integration operation ${adapterId}.${operationName} must validate request URLs`);
  }
}

function requirePositiveInteger(value: number, label: string, maximum: number): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
}

function requireNonNegativeInteger(value: number, label: string, maximum: number): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} must be a non-negative integer no greater than ${maximum}`);
  }
}

function adapterKey(id: string, version: number): string {
  return `${id}@${version}`;
}

function snapshotAdapter<Config extends object, ProtectedPayload extends object>(
  adapter: HostIntegrationAdapter<Config, ProtectedPayload>,
): HostIntegrationAdapterLike {
  const protectedFields = Object.freeze(adapter.protectedFields.map((field) => Object.freeze({ ...field })));
  const operations = Object.freeze(
    Object.fromEntries(
      Object.entries(adapter.operations).map(([name, operation]) => [
        name,
        Object.freeze({
          ...operation,
          network: Object.freeze({
            ...operation.network,
            retry: Object.freeze({
              ...operation.network.retry,
              methods: Object.freeze([...operation.network.retry.methods]),
              statuses: Object.freeze([...operation.network.retry.statuses]),
            }),
            destinations: Object.freeze(
              operation.network.destinations.map((destination) =>
                Object.freeze({ ...destination, methods: Object.freeze([...destination.methods]) }),
              ),
            ),
          }),
          responseLimits: Object.freeze({ ...operation.responseLimits }),
        }),
      ]),
    ),
  );
  return Object.freeze({ ...adapter, protectedFields, operations }) as unknown as HostIntegrationAdapterLike;
}

const defaultRegistry = createHostIntegrationRegistry();

export const registerHostIntegrationAdapter = defaultRegistry.register;
export const getHostIntegrationAdapter = defaultRegistry.get;
export const requireHostIntegrationAdapter = defaultRegistry.require;
export const requireHostIntegrationOperation = defaultRegistry.requireOperation;
export const listHostIntegrationAdapters = defaultRegistry.list;
