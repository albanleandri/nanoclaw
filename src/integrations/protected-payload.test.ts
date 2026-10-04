import { describe, expect, it } from 'vitest';

import { validateAndClassifyProtectedPayload, validateProtectedFieldDeclarations } from './protected-payload.js';
import type { HostIntegrationAdapter } from './types.js';

type Config = { tenant: string };
type Payload = { username: string; password: string };

function adapter(validateProtectedPayload: (value: unknown) => Payload): HostIntegrationAdapter<Config, Payload> {
  return {
    id: 'classified-test',
    version: 1,
    securityTier: 'trusted-host',
    hostAuthJustification: 'Test-only form authentication.',
    validateConfig: () => ({ tenant: 'test' }),
    validateProtectedPayload,
    protectedFields: [
      { name: 'username', sensitivity: 'private', label: 'Username' },
      { name: 'password', sensitivity: 'secret', label: 'Password' },
    ],
    operations: {},
  };
}

describe('protected payload classification', () => {
  it('returns a payload only when every top-level value is classified', () => {
    const value = { username: 'private-person', password: 'sentinel-secret' };
    expect(
      validateAndClassifyProtectedPayload(
        adapter(() => value),
        {},
      ),
    ).toBe(value);
  });

  it('rejects validator output containing an unclassified field without echoing names or values', () => {
    const sentinel = 'SENTINEL_MUST_NOT_ESCAPE';
    const malformed = adapter(
      () => ({ username: 'person', password: 'password', [sentinel]: sentinel }) as unknown as Payload,
    );
    expect(() => validateAndClassifyProtectedPayload(malformed, {})).toThrowError(
      expect.not.objectContaining({ message: expect.stringContaining(sentinel) }),
    );
  });

  it('rejects missing declared fields and non-plain validator output', () => {
    expect(() =>
      validateAndClassifyProtectedPayload(
        adapter(() => ({ username: 'person' }) as Payload),
        {},
      ),
    ).toThrow(/every declared/);
    expect(() =>
      validateAndClassifyProtectedPayload(
        adapter(() => ['person', 'password'] as unknown as Payload),
        {},
      ),
    ).toThrow(/plain object/);
  });

  it('does not allow hidden or symbol-keyed values to bypass classification', () => {
    const hidden = { username: 'person', password: 'password' } as Payload & Record<PropertyKey, unknown>;
    Object.defineProperty(hidden, 'hiddenCredential', { value: 'sentinel', enumerable: false });
    expect(() =>
      validateAndClassifyProtectedPayload(
        adapter(() => hidden),
        {},
      ),
    ).toThrow(/unclassified/);

    const symbolPayload = { username: 'person', password: 'password', [Symbol('secret')]: 'sentinel' };
    expect(() =>
      validateAndClassifyProtectedPayload(
        adapter(() => symbolPayload),
        {},
      ),
    ).toThrow(/symbol-keyed/);
  });

  it('requires unique, named secret/private classifications with safe labels', () => {
    expect(() =>
      validateProtectedFieldDeclarations([{ name: '../password', sensitivity: 'secret', label: 'Password' }]),
    ).toThrow(/Invalid protected field name/);
    expect(() => validateProtectedFieldDeclarations([{ name: 'password', sensitivity: 'private', label: '' }])).toThrow(
      /safe label/,
    );
    expect(() =>
      validateProtectedFieldDeclarations([{ name: 'password', sensitivity: 'private', label: 'Password\u001b[2J' }]),
    ).toThrow(/safe label/);
    expect(() =>
      validateProtectedFieldDeclarations([
        { name: 'password', sensitivity: 'secret', label: 'Password' },
        { name: 'password', sensitivity: 'private', label: 'Account' },
      ]),
    ).toThrow(/declared twice/);
  });
});
