import { describe, expect, it } from 'bun:test';

import { normalizeProviderUsage } from './usage.js';

describe('provider usage normalization', () => {
  it('normalizes snake/camel/OpenAI fields', () => {
    expect(normalizeProviderUsage({ input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3 })).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cachedTokens: 3,
      source: 'provider',
    });
    expect(normalizeProviderUsage({ prompt_tokens: 7, completion_tokens: 2 })).toMatchObject({
      inputTokens: 7,
      outputTokens: 2,
    });
  });

  it('rejects absent, malformed, and negative counters', () => {
    expect(normalizeProviderUsage(undefined)).toBeUndefined();
    expect(normalizeProviderUsage({ input_tokens: -1 })).toBeUndefined();
    expect(normalizeProviderUsage({ input_tokens: '5' })).toBeUndefined();
  });
});
