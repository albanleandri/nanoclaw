import { describe, expect, it } from 'vitest';

import { canCancelActiveAdapter } from './cancellation.js';

describe('orchestration adapter cancellation isolation', () => {
  it('cancels the runner only when the target owns its sole processing claim', () => {
    expect(canCancelActiveAdapter('target', ['target'], true)).toBe(true);
    expect(canCancelActiveAdapter('target', ['target', 'sibling'], true)).toBe(false);
    expect(canCancelActiveAdapter('target', ['other'], true)).toBe(false);
    expect(canCancelActiveAdapter('target', ['target'], false)).toBe(false);
  });
});
