import { describe, expect, it } from 'vitest';

import { resolveDefaultModel } from './config.js';

describe('NANOCLAW_DEFAULT_MODEL resolution', () => {
  it('prefers the process environment over the .env value', () => {
    expect(resolveDefaultModel('process-model', 'file-model')).toBe('process-model');
  });

  it('falls back to the .env value', () => {
    expect(resolveDefaultModel(undefined, 'file-model')).toBe('file-model');
  });

  it('keeps the provider SDK default when neither value is set', () => {
    expect(resolveDefaultModel(undefined, undefined)).toBe('');
    expect(resolveDefaultModel('', '')).toBe('');
  });
});
