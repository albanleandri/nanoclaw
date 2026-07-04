import type { ContainerConfig } from '../container-config.js';
import type { AgentRuntimeDescriptor } from '../providers/runtime-descriptor.js';
import type { AvailabilityContext } from './availability.js';
import type { AgentCapabilityProfile } from './session-runtime-plan.js';

export function runtimeSupportsTools(runtime: AgentRuntimeDescriptor): boolean {
  return runtime.capabilities.mcp !== 'none' && runtime.capabilities.toolCalling !== 'none';
}

export function buildAvailabilityContext(config: ContainerConfig): AvailabilityContext {
  return {
    configuredMcpServers: new Set(Object.keys(config.mcpServers ?? {})),
    writableWorkspace: true,
  };
}

/** Minimal defaults; DB- and skill-declared capability requests land later. */
export function deriveCapabilityProfile(config: ContainerConfig): AgentCapabilityProfile {
  const requested = [
    'nanoclaw.send-message',
    'nanoclaw.schedule-task',
    'nanoclaw.manage-agents',
    'nanoclaw.self-modify',
    'nanoclaw.manage-jobs',
    'nanoclaw.request-agent-task',
    'nanoclaw.get-agent-task',
    'nanoclaw.cancel-agent-task',
    'nanoclaw.report-agent-task-progress',
    'nanoclaw.block-agent-task',
    'nanoclaw.complete-agent-task',
    'nanoclaw.fail-agent-task',
    'nanoclaw.publish-agent-task-artifact',
    'memory.session-search',
    'runtime.shell',
    'nanoclaw.browse-web',
  ];
  // The provider-neutral RTK shell is intentionally limited to the native,
  // container-isolated runtimes. Generic protocol profiles retain their
  // bounded canonical tool contract and record the shell as unavailable.
  const allowDegraded: string[] = ['runtime.shell', 'nanoclaw.browse-web'];
  if ((config.cliScope ?? 'group') !== 'disabled') requested.push('nanoclaw.cli');
  if (Object.keys(config.mcpServers ?? {}).length > 0) {
    requested.push('nanoclaw.external-mcp');
    allowDegraded.push('nanoclaw.external-mcp');
  }
  if (Object.keys(config.mcpServers ?? {}).includes('browser')) {
    requested.push('web.browse');
    allowDegraded.push('web.browse');
  }
  return { requested, allowDegraded };
}

/**
 * Tool-capable runtimes retain the same object and MCP set. Tool-less
 * runtimes receive a copy with no advertised MCP servers.
 */
export function applyToolGating(config: ContainerConfig, runtime: AgentRuntimeDescriptor): ContainerConfig {
  if (runtimeSupportsTools(runtime)) return config;
  return { ...config, mcpServers: {} };
}
