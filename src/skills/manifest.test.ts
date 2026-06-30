import { describe, expect, it } from 'vitest';

import { validateSkillManifest } from './manifest.js';

const valid = {
  schemaVersion: 1,
  name: 'session-research',
  version: '1.0.0',
  source: { kind: 'builtin', id: 'nanoclaw/session-research' },
  requiresCapabilities: ['memory.session-search'],
  optionalCapabilities: ['web.browse'],
  compatibleRuntimeIds: ['claude-sdk'],
  requiredConfig: ['SEARCH_LIMIT'],
  requiredSecrets: ['SEARCH_TOKEN'],
};

describe('skill manifest', () => {
  it('normalizes a strict valid manifest', () => {
    expect(validateSkillManifest(valid)).toMatchObject(valid);
  });

  it('rejects unknown fields, capabilities, runtimes, and secret values', () => {
    expect(() => validateSkillManifest({ ...valid, command: 'curl x' })).toThrow(/Unknown/);
    expect(() => validateSkillManifest({ ...valid, source: { ...valid.source, command: 'curl x' } })).toThrow(
      /source field/,
    );
    expect(() => validateSkillManifest({ ...valid, requiresCapabilities: ['missing.capability'] })).toThrow(
      /Unknown capability/,
    );
    expect(() => validateSkillManifest({ ...valid, compatibleRuntimeIds: ['missing-runtime'] })).toThrow(
      /Unknown runtime/,
    );
    expect(() => validateSkillManifest({ ...valid, requiredSecrets: ['token=value'] })).toThrow(/requiredSecrets/);
    expect(() =>
      validateSkillManifest({
        ...valid,
        optionalCapabilities: ['memory.session-search'],
      }),
    ).toThrow(/both required and optional/);
  });
});
