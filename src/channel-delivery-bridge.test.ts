import { describe, expect, it, vi } from 'vitest';

import { createChannelDeliveryBridge } from './channel-delivery-bridge.js';

describe('channel delivery bridge', () => {
  it('throws when the requested channel adapter is inactive', async () => {
    const bridge = createChannelDeliveryBridge(() => undefined);

    await expect(bridge.deliver('missing-channel', 'destination', null, 'chat', '{"text":"hello"}')).rejects.toThrow(
      /no active adapter.*missing-channel/i,
    );
  });

  it('parses content and delegates to the active adapter', async () => {
    const deliver = vi.fn().mockResolvedValue('platform-id');
    const bridge = createChannelDeliveryBridge(() => ({ deliver }));

    await expect(bridge.deliver('discord', 'destination', 'thread', 'chat', '{"text":"hello"}')).resolves.toBe(
      'platform-id',
    );
    expect(deliver).toHaveBeenCalledWith('destination', 'thread', {
      kind: 'chat',
      content: { text: 'hello' },
      files: undefined,
    });
  });
});
