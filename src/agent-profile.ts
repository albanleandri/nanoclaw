import type { ContainerConfig, McpServerConfig } from './container-config.js';
import type { AgentGroupMemoryControl, AgentMemoryMode } from './db/agent-group-memory-control.js';
import type { AgentGroup } from './types.js';

export type AgentCliScope = 'disabled' | 'group' | 'global';

export interface AgentMemoryProfile {
  workspacePath: string;
  localMemoryFile: string;
  neutralMemoryRoot: string;
  indexPath: string;
  definitionPath: string;
  conversationsPath: string;
  mode: AgentMemoryMode;
  access: 'none' | 'read-only' | 'read-write';
  okfVersion: '0.1';
  indexMaxBytes: number;
  definitionMaxBytes: number;
  renderedMaxBytes: number;
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
  memory: AgentMemoryProfile;
  tools: AgentToolProfile;
  resources: AgentResourceProfile;
}

const DEFAULT_WORKSPACE_PATH = '/workspace/agent';
const DEFAULT_LOCAL_MEMORY_FILE = 'CLAUDE.local.md';
const DEFAULT_NEUTRAL_MEMORY_ROOT = '/workspace/agent/memory';
const DEFAULT_MEMORY_INDEX_PATH = 'index.md';
const DEFAULT_MEMORY_DEFINITION_PATH = 'system/definition.md';
const DEFAULT_CONVERSATIONS_PATH = '/workspace/agent/conversations';
const DEFAULT_MEMORY_INDEX_MAX_BYTES = 12 * 1024;
const DEFAULT_MEMORY_DEFINITION_MAX_BYTES = 8 * 1024;
const DEFAULT_MEMORY_RENDERED_MAX_BYTES = 24 * 1024;

function normalizeCliScope(scope: string | undefined): AgentCliScope {
  if (scope === 'disabled' || scope === 'global') return scope;
  return 'group';
}

export function buildAgentProfile(
  group: AgentGroup,
  config: ContainerConfig,
  runtime?: { memoryControl: AgentGroupMemoryControl; sessionId: string },
): AgentProfile {
  const mode = runtime?.memoryControl.mode ?? 'disabled';
  const access =
    mode === 'disabled'
      ? 'none'
      : runtime?.memoryControl.writer_session_id === runtime?.sessionId
        ? 'read-write'
        : 'read-only';
  return {
    agentGroupId: config.agentGroupId || group.id,
    groupName: config.groupName || group.name,
    assistantName: config.assistantName || group.name,
    memory: {
      workspacePath: DEFAULT_WORKSPACE_PATH,
      localMemoryFile: DEFAULT_LOCAL_MEMORY_FILE,
      neutralMemoryRoot: DEFAULT_NEUTRAL_MEMORY_ROOT,
      indexPath: DEFAULT_MEMORY_INDEX_PATH,
      definitionPath: DEFAULT_MEMORY_DEFINITION_PATH,
      conversationsPath: DEFAULT_CONVERSATIONS_PATH,
      mode,
      access,
      okfVersion: '0.1',
      indexMaxBytes: DEFAULT_MEMORY_INDEX_MAX_BYTES,
      definitionMaxBytes: DEFAULT_MEMORY_DEFINITION_MAX_BYTES,
      renderedMaxBytes: DEFAULT_MEMORY_RENDERED_MAX_BYTES,
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
