import { describe, expect, it } from 'bun:test';

import type { RunnerConfig } from './config.js';
import { buildProtocolToolBroker } from './runtime-bootstrap.js';

function config(): RunnerConfig {
  return {
    provider: 'openai-compatible',
    assistantName: '',
    groupName: '',
    agentGroupId: '',
    maxMessagesPerPrompt: 10,
    mcpServers: {},
    providerProfile: {
      id: 'p',
      name: 'P',
      protocol: 'openai-compatible',
      apiFamily: 'responses',
      baseUrl: 'https://example.test',
      toolStrategy: 'native',
      authMode: 'none',
    },
    sessionRuntimePlan: {
      runtime: { runtimeId: 'openai-protocol-loop' },
      capabilities: [{ id: 'nanoclaw.send-message', adapter: 'protocol-tool', entrypoint: 'tool:send_message' }],
    },
  };
}

describe('buildProtocolToolBroker', () => {
  it('builds a broker only from verified generic plan bindings', () => {
    expect(
      buildProtocolToolBroker(config())
        ?.list()
        .map((tool) => tool.name),
    ).toEqual(['send_message']);
    expect(buildProtocolToolBroker({ ...config(), provider: 'claude' })).toBeUndefined();
    expect(buildProtocolToolBroker({ ...config(), provider: 'codex' })).toBeUndefined();
  });

  it('fails closed for every native-tool plan mismatch', () => {
    expect(() => buildProtocolToolBroker({ ...config(), sessionRuntimePlan: undefined })).toThrow(/plan/);
    expect(() =>
      buildProtocolToolBroker({
        ...config(),
        sessionRuntimePlan: { ...config().sessionRuntimePlan!, runtime: { runtimeId: 'wrong-runtime' } },
      }),
    ).toThrow(/does not match/);
    expect(() =>
      buildProtocolToolBroker({
        ...config(),
        sessionRuntimePlan: {
          ...config().sessionRuntimePlan!,
          capabilities: [{ id: 'nanoclaw.send-message', adapter: 'protocol-tool', entrypoint: 'mcp:send_message' }],
        },
      }),
    ).toThrow(/grants no protocol tools/);
    expect(() =>
      buildProtocolToolBroker({
        ...config(),
        sessionRuntimePlan: { ...config().sessionRuntimePlan!, capabilities: [] },
      }),
    ).toThrow(/grants no protocol tools/);
  });

  it('rejects tool-bearing plans for unverified profiles and permits text-only generic startup', () => {
    expect(() =>
      buildProtocolToolBroker({
        ...config(),
        providerProfile: { ...config().providerProfile!, toolStrategy: 'none' },
      }),
    ).toThrow(/Unverified/);
    expect(
      buildProtocolToolBroker({
        ...config(),
        providerProfile: { ...config().providerProfile!, toolStrategy: 'none' },
        sessionRuntimePlan: undefined,
      }),
    ).toBeUndefined();
  });
});
