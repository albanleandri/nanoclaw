import { describe, expect, it } from 'vitest';

import { namespacedPlatformId, namespacedUserId } from './platform-id.js';

describe('namespacedPlatformId', () => {
  it('preserves an existing channel namespace', () => {
    expect(namespacedPlatformId('telegram', 'telegram:42')).toBe('telegram:42');
  });
});

describe('namespacedUserId', () => {
  it('uses one canonical identity across dedicated Telegram bot aliases', () => {
    expect(namespacedUserId('telegram', '42')).toBe('telegram:42');
    expect(namespacedUserId('telegram_codex', '42')).toBe('telegram:42');
    expect(namespacedUserId('telegram_lumo', 'telegram_lumo:42')).toBe('telegram:42');
  });

  it('preserves unrelated adapter namespaces', () => {
    expect(namespacedUserId('discord', 'discord:user-1')).toBe('discord:user-1');
    expect(namespacedUserId('slack', 'U123')).toBe('slack:U123');
  });
});
