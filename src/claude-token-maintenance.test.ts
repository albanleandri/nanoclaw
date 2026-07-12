import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { refreshOnecliToken } = vi.hoisted(() => ({
  refreshOnecliToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', () => ({
  CLAUDE_ONECLI_SECRET_ID: 'secret-id',
  ONECLI_URL: 'http://onecli.test',
}));
vi.mock('./onecli-token-refresh.js', () => ({ refreshOnecliToken }));
vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  CLAUDE_TOKEN_RECONCILE_INTERVAL_MS,
  startClaudeTokenMaintenance,
  stopClaudeTokenMaintenance,
} from './claude-token-maintenance.js';

describe('Claude token maintenance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refreshOnecliToken.mockClear();
  });

  afterEach(() => {
    stopClaudeTokenMaintenance();
    vi.useRealTimers();
  });

  it('reconciles at startup and every five minutes', async () => {
    startClaudeTokenMaintenance();
    await vi.waitFor(() => expect(refreshOnecliToken).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(CLAUDE_TOKEN_RECONCILE_INTERVAL_MS);
    expect(refreshOnecliToken).toHaveBeenCalledTimes(2);
    expect(refreshOnecliToken).toHaveBeenLastCalledWith(
      expect.objectContaining({ onecliUrl: 'http://onecli.test', secretId: 'secret-id' }),
    );
  });
});
