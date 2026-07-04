import { describe, expect, it } from 'vitest';

import { assertAccessEnforcementWired, setAccessGate } from './router.js';

// These run in declaration order within this file's fresh module registry:
// the access gate starts unregistered and is registered by the last test.
describe('assertAccessEnforcementWired', () => {
  it('throws when privilege rows exist but no access gate is registered', () => {
    expect(() => assertAccessEnforcementWired(3)).toThrow(/allow all senders/);
  });

  it('passes with zero roles (single-user allow-all is intended)', () => {
    expect(() => assertAccessEnforcementWired(0)).not.toThrow();
  });

  it('passes once an access gate is registered', () => {
    setAccessGate(() => ({ allowed: true }));
    expect(() => assertAccessEnforcementWired(3)).not.toThrow();
  });
});
