// Ported from upstream 6a82c287: the runner reads CLAUDE_CODE_AUTO_COMPACT_WINDOW
// from the container env, which the host builds from scratch, so an operator's
// value never reached the container and the override was dead.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' })),
}));

import { claudeCompactWindowEnv } from './claude-compact-window.js';

describe('claudeCompactWindowEnv', () => {
  it('passes the service env value through', () => {
    expect(claudeCompactWindowEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900000' })).toEqual({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900000',
    });
  });

  it('falls back to .env when the service env is empty', () => {
    expect(claudeCompactWindowEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: ' ' })).toEqual({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000',
    });
  });

  it('ignores a value that is not a positive integer', () => {
    expect(claudeCompactWindowEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200k' })).toEqual({});
  });
});
