import { describe, expect, it } from 'vitest';

import { TIMEZONE } from '../config.js';
import { formatLocalStamp } from '../timezone.js';
import type { ResponseFrame } from './frame.js';
import { formatResponse, localizeIsoTimestamps } from './format.js';

describe('CLI timestamp formatting', () => {
  it('localizes complete ISO UTC values recursively for human output', () => {
    const localized = localizeIsoTimestamps({ at: '2026-07-18T12:34:56.000Z', nested: ['2026-07-18T13:00:00Z'] });
    expect(localized).toEqual({
      at: formatLocalStamp(new Date('2026-07-18T12:34:56.000Z'), TIMEZONE),
      nested: [formatLocalStamp(new Date('2026-07-18T13:00:00Z'), TIMEZONE)],
    });
  });

  it('does not rewrite embedded timestamps or offset-bearing values', () => {
    expect(localizeIsoTimestamps('at 2026-07-18T12:34:56.000Z')).toBe('at 2026-07-18T12:34:56.000Z');
    expect(localizeIsoTimestamps('2026-07-18T14:34:56+02:00')).toBe('2026-07-18T14:34:56+02:00');
  });

  it('preserves ISO values in JSON mode', () => {
    const response = { id: '1', ok: true, data: { at: '2026-07-18T12:34:56.000Z' } } satisfies ResponseFrame;
    expect(formatResponse(response, 'json')).toContain('2026-07-18T12:34:56.000Z');
    expect(formatResponse(response, 'human')).toContain(
      formatLocalStamp(new Date('2026-07-18T12:34:56.000Z'), TIMEZONE),
    );
  });
});
