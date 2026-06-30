/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

const CONFIG_PATH = '/workspace/agent/container.json';

export interface RunnerAgentProfile {
  agentGroupId: string;
  groupName: string;
  assistantName: string;
  memory: {
    workspacePath: string;
    localMemoryFile: string;
    neutralMemoryRoot: string;
  };
  tools: {
    skills: string[] | 'all';
    mcpServers: Record<
      string,
      { command: string; args?: string[]; env?: Record<string, string>; instructions?: string }
    >;
    cliScope: 'disabled' | 'group' | 'global';
  };
  resources: {
    sharedResources: string[];
  };
}

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  model?: string;
  effort?: string;
  runtimeStateKey?: string;
  requestSystemInstructions?: string;
  providerProfile?: {
    id: string;
    name: string;
    protocol: 'native' | 'openai-compatible' | 'claude-compatible' | 'local-http';
    baseUrl?: string;
    apiFamily?: 'responses' | 'chat-completions';
    toolStrategy: 'none' | 'native';
    authMode: string;
    authRef?: string;
  };
  agentProfile?: RunnerAgentProfile;
  sessionRuntimePlan?: {
    runtime: { runtimeId: string };
    capabilities: Array<{ id: string; adapter: string; entrypoint: string }>;
  };
}

const DEFAULT_MAX_MESSAGES = 10;

let _config: RunnerConfig | null = null;

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${CONFIG_PATH}, using defaults`);
  }

  _config = {
    provider: (raw.provider as string) || 'claude',
    assistantName: (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers: (raw.mcpServers as RunnerConfig['mcpServers']) || {},
    model: (raw.model as string) || undefined,
    effort: (raw.effort as string) || undefined,
    runtimeStateKey: (raw.runtimeStateKey as string) || undefined,
    requestSystemInstructions: (raw.requestSystemInstructions as string) || undefined,
    providerProfile: (raw.providerProfile as RunnerConfig['providerProfile']) || undefined,
    agentProfile: (raw.agentProfile as RunnerAgentProfile) || undefined,
    sessionRuntimePlan: (raw.sessionRuntimePlan as RunnerConfig['sessionRuntimePlan']) || undefined,
  };

  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
