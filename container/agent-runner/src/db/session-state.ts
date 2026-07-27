/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getOutboundDb } from './connection.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  const row = getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

const AUTH_FAILURE_NOTICE_KEY = 'runtime:auth-failure-notice';

export function shouldNotifyAuthFailure(now = Date.now(), cooldownMs = 24 * 60 * 60 * 1000): boolean {
  const previous = getValue(AUTH_FAILURE_NOTICE_KEY);
  if (previous !== undefined) {
    const previousMs = Date.parse(previous);
    if (!Number.isNaN(previousMs) && now - previousMs < cooldownMs) return false;
  }
  setValue(AUTH_FAILURE_NOTICE_KEY, new Date(now).toISOString());
  return true;
}

export function clearAuthFailureNotice(): void {
  deleteValue(AUTH_FAILURE_NOTICE_KEY);
}

export function createProviderStateStore(runtimeStateKey: string): {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
} {
  const scoped = (key: string) => `provider-state:${runtimeStateKey}:${key}`;
  return {
    get: (key) => getValue(scoped(key)),
    set: (key, value) => setValue(scoped(key), value),
    delete: (key) => deleteValue(scoped(key)),
  };
}

export function clearProviderState(runtimeStateKey: string): void {
  getOutboundDb()
    .prepare("DELETE FROM session_state WHERE key LIKE ? ESCAPE '\\'")
    .run(`provider-state:${runtimeStateKey.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}:%`);
}

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no continuation of its own, adopt
 * the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). The legacy row
 * is always deleted so future provider flips never re-read a stale id
 * through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string, adoptLegacy = true): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;
  if (!adoptLegacy) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  setValue(currentKey, legacy);
  return legacy;
}

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
}
