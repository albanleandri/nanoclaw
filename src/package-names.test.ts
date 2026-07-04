import { describe, expect, it } from 'vitest';

import { validatePackageLists } from './package-names.js';

describe('validatePackageLists', () => {
  it('accepts apt and scoped npm package names', () => {
    expect(validatePackageLists(['libssl-dev'], ['@anthropic-ai/sdk'])).toEqual({
      apt: ['libssl-dev'],
      npm: ['@anthropic-ai/sdk'],
    });
  });

  it.each([
    { apt: 'curl', npm: [] },
    { apt: [42], npm: [] },
    { apt: [], npm: ['left-pad; touch /tmp/pwned'] },
    { apt: ['$(id)'], npm: [] },
  ])('rejects malformed or shell-active persisted values: %j', ({ apt, npm }) => {
    expect(() => validatePackageLists(apt, npm)).toThrow(/package/i);
  });

  it('enforces a caller-supplied package-count limit', () => {
    expect(() =>
      validatePackageLists(
        Array.from({ length: 21 }, (_, index) => `pkg${index}`),
        [],
        { maxCount: 20 },
      ),
    ).toThrow(/20/);
  });
});
