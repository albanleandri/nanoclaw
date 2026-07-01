import { describe, expect, it } from 'vitest';

import './patterns/direct.js';
import { listPatterns, registerPattern, requirePattern } from './pattern-registry.js';

describe('orchestration pattern registry', () => {
  it('registers direct@1 and fails closed for unsupported versions', () => {
    expect(listPatterns().map((pattern) => `${pattern.id}@${pattern.version}`)).toContain('direct@1');
    expect(requirePattern('direct', 1).description).toMatch(/existing session-runtime/);
    expect(() => requirePattern('review', 1)).toThrow(/Unsupported/);
  });

  it('rejects duplicate registrations', () => {
    const direct = requirePattern('direct', 1);
    expect(() => registerPattern(direct)).toThrow(/already registered/);
  });
});
