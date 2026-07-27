import { beforeEach, describe, expect, test } from 'bun:test';

import { getOutboundDb, initTestSessionDb } from './connection.js';
import {
  clearAuthFailureNotice,
  clearProviderState,
  createProviderStateStore,
  clearContinuation,
  getContinuation,
  migrateLegacyContinuation,
  setContinuation,
  shouldNotifyAuthFailure,
} from './session-state.js';

beforeEach(() => {
  initTestSessionDb();
});

function seedLegacy(value: string): void {
  getOutboundDb()
    .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('sdk_session_id', value, new Date().toISOString());
}

describe('session-state — per-provider continuations', () => {
  test('set/get round-trip, case-insensitive provider key', () => {
    setContinuation('claude', 'claude-conv-1');
    expect(getContinuation('claude')).toBe('claude-conv-1');
    expect(getContinuation('Claude')).toBe('claude-conv-1');
    expect(getContinuation('CLAUDE')).toBe('claude-conv-1');
  });

  test('providers are isolated — switching reads the right slot', () => {
    setContinuation('claude', 'claude-conv-1');
    setContinuation('codex', 'codex-thread-xyz');

    expect(getContinuation('claude')).toBe('claude-conv-1');
    expect(getContinuation('codex')).toBe('codex-thread-xyz');
  });

  test('clearContinuation only affects the specified provider', () => {
    setContinuation('claude', 'keep-me');
    setContinuation('codex', 'drop-me');

    clearContinuation('codex');

    expect(getContinuation('claude')).toBe('keep-me');
    expect(getContinuation('codex')).toBeUndefined();
  });

  test('unknown provider returns undefined', () => {
    expect(getContinuation('never-used')).toBeUndefined();
  });
});

describe('session-state — profile provider data', () => {
  test('scopes state and clears only the selected runtime identity', () => {
    const first = createProviderStateStore('profile:first');
    const second = createProviderStateStore('profile:second');
    first.set('transcript', 'one');
    second.set('transcript', 'two');
    clearProviderState('profile:first');
    expect(first.get('transcript')).toBeUndefined();
    expect(second.get('transcript')).toBe('two');
  });
});

describe('session-state — authentication notification cooldown', () => {
  test('notifies once within the cooldown and notifies again at the boundary', () => {
    const start = Date.parse('2026-07-27T00:00:00.000Z');
    const cooldown = 60_000;

    expect(shouldNotifyAuthFailure(start, cooldown)).toBe(true);
    expect(shouldNotifyAuthFailure(start + cooldown - 1, cooldown)).toBe(false);
    expect(shouldNotifyAuthFailure(start + cooldown, cooldown)).toBe(true);
  });

  test('clear resets the cooldown immediately', () => {
    const now = Date.parse('2026-07-27T00:00:00.000Z');
    expect(shouldNotifyAuthFailure(now)).toBe(true);
    expect(shouldNotifyAuthFailure(now + 1)).toBe(false);

    clearAuthFailureNotice();

    expect(shouldNotifyAuthFailure(now + 1)).toBe(true);
  });
});

describe('session-state — legacy migration', () => {
  test('adopts legacy value into current provider when current is empty', () => {
    seedLegacy('old-session-id');

    const adopted = migrateLegacyContinuation('claude');

    expect(adopted).toBe('old-session-id');
    expect(getContinuation('claude')).toBe('old-session-id');
  });

  test('always deletes legacy row regardless of migration outcome', () => {
    seedLegacy('old-session-id');
    setContinuation('claude', 'existing');

    migrateLegacyContinuation('claude');

    // After migration the legacy key must be gone, whether or not it was adopted.
    // A subsequent migration for a different provider must not see it.
    const resultAfterSecondCall = migrateLegacyContinuation('codex');
    expect(resultAfterSecondCall).toBeUndefined();
  });

  test('prefers existing current-provider slot over legacy', () => {
    seedLegacy('legacy-value');
    setContinuation('claude', 'claude-value');

    const result = migrateLegacyContinuation('claude');

    expect(result).toBe('claude-value');
    expect(getContinuation('claude')).toBe('claude-value');
  });

  test('no legacy row — returns current provider value (possibly undefined)', () => {
    expect(migrateLegacyContinuation('claude')).toBeUndefined();

    setContinuation('codex', 'codex-value');
    expect(migrateLegacyContinuation('codex')).toBe('codex-value');
  });

  test('migration is idempotent on a second call (legacy already gone)', () => {
    seedLegacy('once');

    const first = migrateLegacyContinuation('claude');
    expect(first).toBe('once');

    const second = migrateLegacyContinuation('claude');
    expect(second).toBe('once');
  });
});
