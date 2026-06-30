import type { RunnerConfig } from './config.js';
import { listRegisteredToolDefinitions } from './mcp-tools/catalog.js';
import { createProtocolToolBroker } from './tool-loop/broker.js';
import type { ProtocolToolBroker } from './tool-loop/types.js';

export function buildProtocolToolBroker(config: RunnerConfig): ProtocolToolBroker | undefined {
  if (config.provider.toLowerCase() !== 'openai-compatible') return undefined;
  const enabled = config.providerProfile?.toolStrategy === 'native';
  if (!enabled) {
    if (config.sessionRuntimePlan?.capabilities.some((item) => item.adapter === 'protocol-tool')) {
      throw new Error('Unverified provider profile cannot receive protocol tool bindings');
    }
    return undefined;
  }
  if (!config.sessionRuntimePlan) throw new Error('Tool-enabled provider profile requires a compiled runtime plan');
  if (config.sessionRuntimePlan.runtime.runtimeId !== 'openai-protocol-loop') {
    throw new Error('Compiled runtime plan does not match openai protocol loop');
  }
  const broker = createProtocolToolBroker(config.sessionRuntimePlan, listRegisteredToolDefinitions());
  if (broker.list().length === 0) throw new Error('Compiled runtime plan grants no protocol tools');
  return broker;
}
