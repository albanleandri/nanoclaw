import { describe, expect, it } from 'vitest';

import {
  detectUsageLimitError,
  formatUsageLimitMessage,
  isUsageLimitActive,
  UsageLimitState,
} from './usage-limit.js';

describe('usage-limit detection', () => {
  it('detects explicit ISO reset timestamps', () => {
    const detection = detectUsageLimitError(
      '429 rate limit exceeded. Try again after 2026-04-12T14:30:00Z',
      new Date('2026-04-12T13:00:00Z'),
    );

    expect(detection).toEqual({
      retryAt: '2026-04-12T14:30:00Z',
      suppressUntil: '2026-04-12T14:30:00Z',
    });
  });

  it('detects relative retry windows', () => {
    const detection = detectUsageLimitError(
      'Usage limit reached. Please retry after 1h 15m.',
      new Date('2026-04-12T13:00:00Z'),
    );

    expect(detection?.retryAt).toBe('2026-04-12T14:15:00.000Z');
    expect(detection?.suppressUntil).toBe('2026-04-12T14:15:00.000Z');
  });

  it('falls back to a short suppress window when reset time is unavailable', () => {
    const detection = detectUsageLimitError(
      '429 quota exceeded for this workspace.',
      new Date('2026-04-12T13:00:00Z'),
    );

    expect(detection?.retryAt).toBeUndefined();
    expect(detection?.suppressUntil).toBe('2026-04-12T13:15:00.000Z');
  });

  it('ignores unrelated errors', () => {
    expect(
      detectUsageLimitError(
        'Container exited with code 1: ENOENT missing file',
        new Date('2026-04-12T13:00:00Z'),
      ),
    ).toBeNull();
  });
});

describe('usage-limit messaging', () => {
  it('formats same-day retry messages concisely', () => {
    const message = formatUsageLimitMessage(
      { retryAt: '2026-04-12T14:30:00Z' },
      'Europe/Zurich',
      new Date('2026-04-12T13:00:00Z'),
    );

    expect(message).toBe(
      'Usage limit reached. Try again after 16:30 Europe/Zurich.',
    );
  });

  it('formats cross-day retry messages with date', () => {
    const message = formatUsageLimitMessage(
      { retryAt: '2026-04-13T08:00:00Z' },
      'Europe/Zurich',
      new Date('2026-04-12T13:00:00Z'),
    );

    expect(message).toBe(
      'Usage limit reached. Try again after Apr 13, 10:00 Europe/Zurich.',
    );
  });

  it('formats a generic fallback when reset time is unknown', () => {
    expect(
      formatUsageLimitMessage(
        {},
        'Europe/Zurich',
        new Date('2026-04-12T13:00:00Z'),
      ),
    ).toBe(
      "Usage limit reached. I can't process requests right now. Reset time unavailable; try again later.",
    );
  });

  it('tracks whether a usage-limit state is still active', () => {
    const state: UsageLimitState = {
      detectedAt: '2026-04-12T13:00:00.000Z',
      suppressUntil: '2026-04-12T13:15:00.000Z',
      lastNotifiedAt: '2026-04-12T13:00:00.000Z',
      lastError: '429 rate limit',
    };

    expect(isUsageLimitActive(state, new Date('2026-04-12T13:10:00Z'))).toBe(
      true,
    );
    expect(isUsageLimitActive(state, new Date('2026-04-12T13:15:00Z'))).toBe(
      false,
    );
  });
});
