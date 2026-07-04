import type { ChannelAdapter } from './channels/adapter.js';
import { getChannelAdapter } from './channels/channel-registry.js';
import type { ChannelDeliveryAdapter } from './delivery.js';

type DeliveryTarget = Pick<ChannelAdapter, 'deliver' | 'setTyping'>;
type AdapterLookup = (channelType: string) => DeliveryTarget | undefined;

/** Bridge session delivery rows to live channel adapters. */
export function createChannelDeliveryBridge(lookup: AdapterLookup = getChannelAdapter): ChannelDeliveryAdapter {
  function requireAdapter(channelType: string): DeliveryTarget {
    const adapter = lookup(channelType);
    if (!adapter) throw new Error(`No active adapter for channel type: ${channelType}`);
    return adapter;
  }

  return {
    async deliver(channelType, platformId, threadId, kind, content, files) {
      const adapter = requireAdapter(channelType);
      return adapter.deliver(platformId, threadId, {
        kind,
        content: JSON.parse(content),
        files,
      });
    },
    async setTyping(channelType, platformId, threadId) {
      await lookup(channelType)?.setTyping?.(platformId, threadId);
    },
    async sendStatus(channelType, platformId, threadId, text) {
      const adapter = requireAdapter(channelType);
      await adapter.deliver(platformId, threadId, { kind: 'chat', content: { text } });
    },
  };
}
