import type { AgentRuntimeDescriptor } from '../providers/runtime-descriptor.js';
import { runAvailabilityCheck, type AvailabilityContext } from './availability.js';
import type { CapabilityAdapter, CapabilityManifest, CapabilitySupport } from './capability-manifest.js';

export interface ResolvedSupport {
  support: CapabilitySupport;
  adapter?: CapabilityAdapter;
  reason?: string;
}

export function resolveCapabilitySupport(
  manifest: CapabilityManifest,
  runtime: AgentRuntimeDescriptor,
  context: AvailabilityContext,
  policy: { writableWorkspace: boolean },
  endpointCapabilities?: { toolCalling: 'native' | 'prompt-mediated' | 'none' },
): ResolvedSupport {
  let reason = 'no adapter matched the selected runtime';
  const adapters =
    runtime.kind === 'protocol-loop' && endpointCapabilities?.toolCalling === 'native'
      ? [...manifest.adapters].sort((a, b) => Number(b.kind === 'protocol-tool') - Number(a.kind === 'protocol-tool'))
      : manifest.adapters;
  for (const adapter of adapters) {
    if (adapter.runtimeIds && !adapter.runtimeIds.includes(runtime.id)) continue;

    if (manifest.requirements.workspace === 'write' && !policy.writableWorkspace) {
      reason = `${manifest.id} requires a writable workspace but the session is read-only`;
      continue;
    }

    if (adapter.kind === 'native-runtime') {
      if (runtime.capabilities.toolCalling !== 'native') {
        reason = `${manifest.id} native adapter requires native tool calling`;
        continue;
      }
      return { support: 'native', adapter };
    }

    if (adapter.kind === 'mcp') {
      if (runtime.capabilities.mcp === 'none') {
        reason = `${manifest.id} MCP adapter requires an MCP-capable runtime`;
        continue;
      }
      if (adapter.availabilityCheck && !runAvailabilityCheck(adapter.availabilityCheck, context, adapter)) {
        reason = `${manifest.id} MCP adapter failed availability check ${adapter.availabilityCheck}`;
        continue;
      }
      return { support: 'bridged', adapter };
    }

    if (adapter.kind === 'protocol-tool') {
      if (runtime.kind !== 'protocol-loop' || endpointCapabilities?.toolCalling !== 'native') {
        reason = `${manifest.id} protocol adapter requires verified endpoint tool calling`;
        continue;
      }
      return { support: 'bridged', adapter };
    }

    if (adapter.availabilityCheck && !runAvailabilityCheck(adapter.availabilityCheck, context, adapter)) {
      reason = `${manifest.id} adapter failed availability check ${adapter.availabilityCheck}`;
      continue;
    }
    return { support: 'bridged', adapter };
  }
  return { support: 'unsupported', reason };
}
