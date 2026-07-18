import { describe, expect, it } from 'vitest';

import { telegramBotUrl } from './telegram.js';

describe('telegramBotUrl', () => {
  it('uses Telegram’s working long-form deep-link host', () => {
    expect(telegramBotUrl('nanoclaw_bot')).toBe('https://telegram.me/nanoclaw_bot');
  });
});
