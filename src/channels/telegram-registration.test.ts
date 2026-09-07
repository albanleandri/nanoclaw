import { describe, expect, it } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './telegram.js';

describe('Telegram channel registration', () => {
  it('registers the dedicated Claude, Codex, and Lumo adapters', () => {
    expect(getRegisteredChannelNames()).toEqual(
      expect.arrayContaining(['telegram', 'telegram_codex', 'telegram_lumo']),
    );
  });
});
