/**
 * Determine whether a platform ID needs a channel-type prefix.
 *
 * Chat SDK adapters (Telegram, Discord, Slack, Teams, etc.) namespace their
 * platform IDs with a channel prefix: "telegram:123456", "discord:guild:chan".
 * The router stores channel_type and platform_id in separate columns, but
 * Chat SDK adapters send the prefixed form as the platform_id — so any code
 * that writes messaging_groups rows must produce the same shape the adapter
 * will later emit as event.platformId, or router lookups miss and messages
 * get silently dropped.
 *
 * Native adapters (Signal, WhatsApp, iMessage, DeltaChat) use their own ID
 * formats and send them as-is — no channel prefix. WhatsApp/iMessage emit
 * JIDs/emails containing '@'. Signal emits raw phone numbers ('+15551234567')
 * for DMs and 'group:<id>' for group chats. DeltaChat emits numeric chat IDs
 * ('12'). Prefixing any of these would cause a mismatch with what the adapter
 * later emits.
 */
export function namespacedPlatformId(channel: string, raw: string): string {
  if (raw.startsWith(`${channel}:`)) return raw;
  if (raw.includes('@')) return raw;
  if (raw.startsWith('+') || raw.startsWith('group:')) return raw;
  if (channel === 'deltachat') return raw;
  return `${channel}:${raw}`;
}

/**
 * Namespace a human identity independently from the bot identity that received
 * the message. Dedicated Telegram bots use channel types such as
 * `telegram_codex` and `telegram_lumo`, but the same Telegram account must map
 * to one permissions row across all of them.
 */
export function namespacedUserId(channel: string, raw: string): string {
  const canonicalChannel = channel === 'telegram' || channel.startsWith('telegram_') ? 'telegram' : channel;

  if (!raw.includes(':')) return `${canonicalChannel}:${raw}`;

  const separator = raw.indexOf(':');
  const rawChannel = raw.slice(0, separator);
  const rawId = raw.slice(separator + 1);
  if (rawChannel === 'telegram' || rawChannel.startsWith('telegram_')) {
    return `telegram:${rawId}`;
  }
  return raw;
}
