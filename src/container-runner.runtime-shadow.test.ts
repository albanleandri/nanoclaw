import { describe, expect, it, vi } from 'vitest';

import { computeRuntimeShadow } from './container-runner.js';
import type { EffectiveProviderConfig } from './providers/effective-provider.js';

describe('computeRuntimeShadow', () => {
  it('returns and logs a valid shadow selection', () => {
    const config: EffectiveProviderConfig = { provider: 'claude', model: 'opus', runtimeStateKey: 'claude' };
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const selection = computeRuntimeShadow(config, logger);
    expect(selection?.runtimeId).toBe('claude-sdk');
    expect(logger.debug).toHaveBeenCalledWith(
      'runtime shadow selection',
      expect.objectContaining({ runtimeId: 'claude-sdk' }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns and returns undefined when shadow resolution fails', () => {
    const config: EffectiveProviderConfig = { provider: 'unknown-xyz', runtimeStateKey: 'unknown-xyz' };
    const logger = { debug: vi.fn(), warn: vi.fn() };
    expect(computeRuntimeShadow(config, logger)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
