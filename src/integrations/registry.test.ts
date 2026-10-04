import { describe, expect, it } from 'vitest';

import {
  createHostIntegrationRegistry,
  listHostIntegrationAdapters,
  registerHostIntegrationAdapter,
  requireHostIntegrationAdapter,
  validateHostIntegrationAdapter,
} from './registry.js';
import type { HostIntegrationAdapter } from './types.js';

type TestConfig = { tenant: string };
type TestPayload = { username: string; password: string };

function adapter(
  overrides: Partial<HostIntegrationAdapter<TestConfig, TestPayload>> = {},
): HostIntegrationAdapter<TestConfig, TestPayload> {
  return {
    id: 'test-portal',
    version: 1,
    securityTier: 'trusted-host',
    hostAuthJustification: 'The portal requires an HTML form login and a host-owned cookie session.',
    validateConfig: () => ({ tenant: 'example' }),
    validateProtectedPayload: () => ({ username: 'person', password: 'sentinel' }),
    protectedFields: [
      { name: 'username', sensitivity: 'private', label: 'Portal username' },
      { name: 'password', sensitivity: 'secret', label: 'Portal password' },
    ],
    operations: {
      'records.read': {
        name: 'records.read',
        sideEffects: 'none',
        validateInput: (value) => value,
        validateOutput: (value) => value,
        totalDeadlineMs: 15_000,
        network: {
          destinations: [
            {
              origin: 'https://portal.example',
              methods: ['GET', 'POST'],
              isAllowedUrl: (url) => url.pathname.startsWith('/tenant/'),
            },
          ],
          maxRedirects: 3,
          requestDeadlineMs: 8_000,
          maxCookies: 32,
          retry: { methods: ['GET'], statuses: [502, 503, 504], maxAttempts: 2, maxRetryAfterMs: 1_000 },
        },
        responseLimits: {
          maxHeaderBytes: 16_384,
          maxCookieBytes: 8_192,
          maxBodyBytes: 1_048_576,
          maxNormalizedOutputBytes: 131_072,
        },
        execute: async ({ input }) => input,
      },
    },
    ...overrides,
  };
}

describe('host integration registry', () => {
  it('keeps the process registry dormant until code explicitly registers an adapter', () => {
    expect(listHostIntegrationAdapters()).toEqual([]);
    registerHostIntegrationAdapter(adapter({ id: 'default-test' }));
    expect(requireHostIntegrationAdapter('default-test', 1).id).toBe('default-test');
  });

  it('registers exact versions, normalizes lookup, and sorts deterministically', () => {
    const registry = createHostIntegrationRegistry();
    registry.register(adapter({ id: 'z-portal' }));
    registry.register(adapter({ id: 'a-portal', version: 2 }));
    registry.register(adapter({ id: 'a-portal', version: 1 }));

    expect(registry.get(' A-PORTAL ', 2)?.version).toBe(2);
    expect(registry.get('a-portal', 3)).toBeUndefined();
    expect(registry.list().map((item) => `${item.id}@${item.version}`)).toEqual([
      'a-portal@1',
      'a-portal@2',
      'z-portal@1',
    ]);
  });

  it('rejects duplicate adapter versions while allowing retained older versions', () => {
    const registry = createHostIntegrationRegistry();
    registry.register(adapter());
    registry.register(adapter({ version: 2 }));
    expect(() => registry.register(adapter())).toThrow(/already registered/);
    expect(registry.require('test-portal', 1).version).toBe(1);
    expect(registry.require('test-portal', 2).version).toBe(2);
    expect(registry.requireOperation('test-portal', 1, 'records.read').name).toBe('records.read');
    expect(() => registry.require('test-portal', 3)).toThrow(/Unknown host integration adapter/);
    expect(() => registry.requireOperation('test-portal', 1, 'agenda.write')).toThrow(
      /Unknown host integration operation/,
    );
    expect(() => registry.requireOperation('test-portal', 1, 'toString')).toThrow(/Unknown host integration operation/);
  });

  it('stores an immutable snapshot instead of mutable caller-owned declarations', () => {
    const registry = createHostIntegrationRegistry();
    const source = adapter();
    registry.register(source);
    source.protectedFields[0]!.label = 'Changed after review';
    (source.operations['records.read']!.network.destinations[0]!.methods as string[])[0] = 'POST';

    const stored = registry.require('test-portal', 1);
    expect(stored.protectedFields[0]?.label).toBe('Portal username');
    expect(stored.operations['records.read']?.network.destinations[0]?.methods).toEqual(['GET', 'POST']);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.operations)).toBe(true);
  });

  it.each([
    ['invalid id', { id: 'Not Valid' }, /kebab-case/],
    ['zero version', { version: 0 }, /positive integer version/],
    ['missing justification', { hostAuthJustification: ' ' }, /justify/],
    ['no protected fields', { protectedFields: [] }, /at least one protected field/],
    [
      'duplicate protected fields',
      {
        protectedFields: [
          { name: 'password', sensitivity: 'secret', label: 'One' },
          { name: 'password', sensitivity: 'secret', label: 'Two' },
        ],
      },
      /declared twice/,
    ],
    ['no operations', { operations: {} }, /no operations/],
  ] as const)('rejects %s', (_label, override, expected) => {
    expect(() => validateHostIntegrationAdapter(adapter(override))).toThrow(expected);
  });

  it('rejects write operations, mismatched names, unsafe origins, and unbounded declarations', () => {
    const original = adapter().operations['records.read']!;
    const invalid = (operation: object): HostIntegrationAdapter<TestConfig, TestPayload> =>
      adapter({ operations: { 'records.read': { ...original, ...operation } } });

    expect(() => validateHostIntegrationAdapter(invalid({ sideEffects: 'external-write' }))).toThrow(/read-only/);
    expect(() => validateHostIntegrationAdapter(invalid({ name: 'other.read' }))).toThrow(/mismatched/);
    expect(() =>
      validateHostIntegrationAdapter(invalid({ network: { ...original.network, destinations: [] } })),
    ).toThrow(/network destination/);
    expect(() =>
      validateHostIntegrationAdapter(
        invalid({
          network: {
            ...original.network,
            destinations: [{ ...original.network.destinations[0]!, origin: 'http://portal.example' }],
          },
        }),
      ),
    ).toThrow(/exact HTTPS origin/);
    expect(() => validateHostIntegrationAdapter(invalid({ totalDeadlineMs: 0 }))).toThrow(/total deadline/);
    expect(() =>
      validateHostIntegrationAdapter(
        invalid({ responseLimits: { ...original.responseLimits, maxBodyBytes: 20 * 1024 * 1024 } }),
      ),
    ).toThrow(/maxBodyBytes/);
    expect(() =>
      validateHostIntegrationAdapter(
        invalid({ responseLimits: { maxHeaderBytes: 1 } as typeof original.responseLimits }),
      ),
    ).toThrow(/exact response limits/);
  });
});
