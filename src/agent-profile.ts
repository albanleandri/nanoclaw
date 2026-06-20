import type { ContainerConfig, McpServerConfig } from './container-config.js';
import type { AgentGroup } from './types.js';

export type AgentCliScope = 'disabled' | 'group' | 'global';

export interface AgentMemoryProfile {
  workspacePath: string;
  localMemoryFile: string;
  neutralMemoryRoot: string;
}

export interface AgentToolProfile {
  skills: string[] | 'all';
  mcpServers: Record<string, McpServerConfig>;
  cliScope: AgentCliScope;
}

export interface AgentResourceProfile {
  sharedResources: string[];
}

export interface AgentProfile {
  agentGroupId: string;
  groupName: string;
  assistantName: string;
  roleInstructions?: string;
  memory: AgentMemoryProfile;
  tools: AgentToolProfile;
  resources: AgentResourceProfile;
}

const DEFAULT_WORKSPACE_PATH = '/workspace/agent';
const DEFAULT_LOCAL_MEMORY_FILE = 'CLAUDE.local.md';
const DEFAULT_NEUTRAL_MEMORY_ROOT = '/workspace/agent/memory';

function normalizeCliScope(scope: string | undefined): AgentCliScope {
  if (scope === 'disabled' || scope === 'global') return scope;
  return 'group';
}

export function buildAgentProfile(group: AgentGroup, config: ContainerConfig): AgentProfile {
  return {
    agentGroupId: config.agentGroupId || group.id,
    groupName: config.groupName || group.name,
    assistantName: config.assistantName || group.name,
    memory: {
      workspacePath: DEFAULT_WORKSPACE_PATH,
      localMemoryFile: DEFAULT_LOCAL_MEMORY_FILE,
      neutralMemoryRoot: DEFAULT_NEUTRAL_MEMORY_ROOT,
    },
    tools: {
      skills: config.skills,
      mcpServers: config.mcpServers,
      cliScope: normalizeCliScope(config.cliScope),
    },
    resources: {
      sharedResources: config.sharedResources ?? [],
    },
  };
}
