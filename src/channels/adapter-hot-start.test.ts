import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelSetup } from './adapter.js';

function fakeAdapter(channelType: string): ChannelAdapter & { setups: ChannelSetup[] } {
  const setups: ChannelSetup[] = [];
  return {
    name: channelType,
    channelType,
    supportsThreads: false,
    setups,
    async setup(config) {
      setups.push(config);
    },
    async teardown() {},
    isConnected: () => setups.length > 0,
    async deliver() {
      return undefined;
    },
  };
}

function setupFactory() {
  const byAdapter = new Map<ChannelAdapter, ChannelSetup>();
  const setupFn = (adapter: ChannelAdapter): ChannelSetup => {
    const setup: ChannelSetup = {
      onInbound() {},
      onInboundEvent() {},
      onMetadata() {},
      onAction() {},
    };
    byAdapter.set(adapter, setup);
    return setup;
  };
  return { setupFn, byAdapter };
}

describe('startChannelAdapter', () => {
  beforeEach(() => vi.resetModules());

  afterEach(async () => {
    vi.useRealTimers();
    const registry = await import('./channel-registry.js');
    await registry.teardownChannelAdapters();
    vi.resetModules();
  });

  it('requires boot initialization', async () => {
    const registry = await import('./channel-registry.js');
    registry.registerChannelAdapter('late', { factory: () => fakeAdapter('late') });
    await expect(registry.startChannelAdapter('late')).rejects.toThrow('initChannelAdapters has not run');
  });

  it('rejects an unknown registration', async () => {
    const registry = await import('./channel-registry.js');
    await registry.initChannelAdapters(setupFactory().setupFn);
    await expect(registry.startChannelAdapter('missing')).rejects.toThrow("no registration for 'missing'");
  });

  it('starts a post-boot registration with the captured setup', async () => {
    const registry = await import('./channel-registry.js');
    const { setupFn, byAdapter } = setupFactory();
    await registry.initChannelAdapters(setupFn);
    const adapter = fakeAdapter('late');
    registry.registerChannelAdapter('late', { factory: () => adapter });

    await expect(registry.startChannelAdapter('late')).resolves.toBe('started');
    expect(registry.getChannelAdapter('late')).toBe(adapter);
    expect(adapter.setups).toEqual([byAdapter.get(adapter)]);
  });

  it('is idempotent after a successful start', async () => {
    const registry = await import('./channel-registry.js');
    await registry.initChannelAdapters(setupFactory().setupFn);
    const factory = vi.fn(() => fakeAdapter('late'));
    registry.registerChannelAdapter('late', { factory });

    await expect(registry.startChannelAdapter('late')).resolves.toBe('started');
    await expect(registry.startChannelAdapter('late')).resolves.toBe('already-active');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('reports missing credentials without activating the registration', async () => {
    const registry = await import('./channel-registry.js');
    await registry.initChannelAdapters(setupFactory().setupFn);
    registry.registerChannelAdapter('late', { factory: () => null });

    await expect(registry.startChannelAdapter('late')).resolves.toBe('no-credentials');
    expect(registry.getChannelAdapter('late')).toBeUndefined();
  });

  it('retries transient NetworkError setup failures', async () => {
    vi.useFakeTimers();
    const registry = await import('./channel-registry.js');
    await registry.initChannelAdapters(setupFactory().setupFn);
    const adapter = fakeAdapter('late');
    let attempts = 0;
    adapter.setup = async (setup) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('temporary');
        error.name = 'NetworkError';
        throw error;
      }
      adapter.setups.push(setup);
    };
    registry.registerChannelAdapter('late', { factory: () => adapter });

    const pending = registry.startChannelAdapter('late');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toBe('started');
    expect(attempts).toBe(2);
  });

  it('does not activate a non-network setup failure', async () => {
    const registry = await import('./channel-registry.js');
    await registry.initChannelAdapters(setupFactory().setupFn);
    const adapter = fakeAdapter('late');
    adapter.setup = async () => {
      throw new Error('bad credentials');
    };
    registry.registerChannelAdapter('late', { factory: () => adapter });

    await expect(registry.startChannelAdapter('late')).rejects.toThrow('bad credentials');
    expect(registry.getChannelAdapter('late')).toBeUndefined();
  });

  it('refuses to replace a live adapter of the same channel type', async () => {
    const registry = await import('./channel-registry.js');
    registry.registerChannelAdapter('boot', { factory: () => fakeAdapter('shared') });
    await registry.initChannelAdapters(setupFactory().setupFn);
    registry.registerChannelAdapter('late', { factory: () => fakeAdapter('shared') });

    await expect(registry.startChannelAdapter('late')).rejects.toThrow("channel type 'shared' is already active");
  });
});
