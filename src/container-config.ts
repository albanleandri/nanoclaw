/**
 * Container config types and materialization.
 *
 * Source of truth is the `container_configs` table in the central DB.
 * This module provides:
 *   - Type definitions for the file shape (read by the container runner)
 *   - `materializeContainerJson()` — writes `groups/<folder>/container.json`
 *     from the DB at spawn time
 *   - `configFromDb()` — builds a `ContainerConfig` from a DB row + agent group
 */
import fs from 'fs';
import path from 'path';

import { buildAgentProfile, type AgentProfile } from './agent-profile.js';
import { GROUPS_DIR } from './config.js';
import { getContainerConfig } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getAgentGroupMemoryControl } from './db/agent-group-memory-control.js';
import { collectInstructionSections, type InstructionSection } from './instruction-sections.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';
import type { EffectiveProviderConfig, EffectiveProviderProfile } from './providers/effective-provider.js';
import type { ProviderCapabilities } from './providers/provider-descriptor.js';
import type { SessionRuntimePlan } from './capabilities/session-runtime-plan.js';
import { writePrivateFileSync } from './private-files.js';
import { log } from './log.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  sharedResources?: string[];
  cliScope?: 'disabled' | 'group' | 'global';
  provider?: string;
  providerProfileId?: string;
  providerProfile?: EffectiveProviderProfile;
  runtimeStateKey?: string;
  providerCapabilities?: ProviderCapabilities;
  requestSystemInstructions?: string;
  groupName?: string;
  assistantName?: string;
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  model?: string;
  effort?: string;
  agentProfile?: AgentProfile;
  sessionRuntimePlan?: SessionRuntimePlan;
}

/** Build a `ContainerConfig` from a DB row + agent group identity. */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  const config: ContainerConfig = {
    mcpServers: JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>,
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    skills: JSON.parse(row.skills) as string[] | 'all',
    sharedResources: JSON.parse(row.shared_resources) as string[],
    cliScope: row.cli_scope === 'disabled' || row.cli_scope === 'global' ? row.cli_scope : 'group',
    provider: row.provider ?? undefined,
    providerProfileId: row.provider_profile_id ?? undefined,
    groupName: group.name,
    assistantName: row.assistant_name ?? group.name,
    agentGroupId: group.id,
    maxMessagesPerPrompt: row.max_messages_per_prompt ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
  };
  // The neutral profile is *derived* from the same config (and group) above, so
  // the top-level fields and `agentProfile` cannot disagree at build time. It is
  // materialized for runner introspection and future providers — see
  // docs/agent-profile.md. The derivation invariant is locked by
  // container-config-materialize.test.ts; keep it that way if this changes.
  config.agentProfile = buildAgentProfile(group, config);
  return config;
}

const REQUEST_SYSTEM_CONTEXT_MAX_BYTES = 64 * 1024;

function instructionContent(projectRoot: string, section: InstructionSection): string {
  if (section.content) return section.content;
  if (!section.containerPath) return '';
  const mappings: Array<[string, string]> = [
    ['/app/CLAUDE.md', path.join(projectRoot, 'container', 'CLAUDE.md')],
    ['/app/skills/', path.join(projectRoot, 'container', 'skills') + path.sep],
    ['/app/src/mcp-tools/', path.join(projectRoot, 'container', 'agent-runner', 'src', 'mcp-tools') + path.sep],
  ];
  for (const [containerPrefix, hostPrefix] of mappings) {
    if (section.containerPath === containerPrefix) {
      return fs.existsSync(hostPrefix) ? fs.readFileSync(hostPrefix, 'utf8') : '';
    }
    if (section.containerPath.startsWith(containerPrefix) && containerPrefix.endsWith('/')) {
      const hostPath = path.join(hostPrefix, section.containerPath.slice(containerPrefix.length));
      return fs.existsSync(hostPath) ? fs.readFileSync(hostPath, 'utf8') : '';
    }
  }
  return '';
}

export function buildRequestSystemInstructions(group: AgentGroup, config: ContainerConfig): string {
  const profile = config.agentProfile ?? buildAgentProfile(group, config);
  const sections = collectInstructionSections({
    projectRoot: process.cwd(),
    profile,
    provider: config.provider,
    capabilityIds: config.sessionRuntimePlan?.capabilities.map((item) => item.id),
  }).sort((a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required)));
  const chunks = [
    {
      name: 'Agent identity',
      required: true,
      content: `# Agent identity\n\nYou are ${profile.assistantName}, agent group ${profile.groupName}.`,
    },
    ...sections.map((section) => {
      const content = instructionContent(process.cwd(), section).trim();
      return {
        name: section.title,
        required: Boolean(section.required),
        content: content ? `# ${section.title}\n\n${content}` : '',
      };
    }),
  ].filter((chunk) => chunk.content);
  const selected = [...chunks];
  const dropped: string[] = [];
  const render = (): string => {
    const omission = dropped.length
      ? `# Omitted for size\n\nOptional instruction sections omitted to fit the request context limit: ${dropped.join(', ')}.`
      : '';
    return [...selected.map((chunk) => chunk.content), omission].filter(Boolean).join('\n\n');
  };
  let output = render();
  while (Buffer.byteLength(output, 'utf8') > REQUEST_SYSTEM_CONTEXT_MAX_BYTES) {
    const candidate = selected
      .filter((chunk) => !chunk.required)
      .sort((a, b) => Buffer.byteLength(b.content, 'utf8') - Buffer.byteLength(a.content, 'utf8'))[0];
    if (!candidate) {
      throw new Error('Required request system instructions exceed the 64 KiB context limit');
    }
    selected.splice(selected.indexOf(candidate), 1);
    dropped.push(candidate.name);
    output = render();
  }
  if (dropped.length > 0) {
    log.error('Request system instructions exceeded context cap; optional sections omitted', {
      group: group.name,
      bytes: Buffer.byteLength(output, 'utf8'),
      dropped,
    });
  }
  log.info('Composed request system instructions', {
    group: group.name,
    bytes: Buffer.byteLength(output, 'utf8'),
    estimatedTokens: Math.ceil(Buffer.byteLength(output, 'utf8') / 4),
    sections: selected.map((chunk) => ({
      section: chunk.name,
      bytes: Buffer.byteLength(chunk.content, 'utf8'),
    })),
    dropped,
  });
  return output;
}

export function materializeSessionRuntimeJson(
  sessionDir: string,
  group: AgentGroup,
  groupConfig: ContainerConfig,
  effective: EffectiveProviderConfig,
  sessionRuntimePlan?: SessionRuntimePlan,
  sessionId = path.basename(sessionDir),
): { config: ContainerConfig; path: string } {
  const config: ContainerConfig = {
    ...groupConfig,
    provider: effective.provider,
    model: effective.model,
    effort: effective.effort,
    providerProfile: effective.profile,
    runtimeStateKey: effective.runtimeStateKey,
    providerCapabilities: effective.capabilities,
    ...(sessionRuntimePlan ? { sessionRuntimePlan } : {}),
  };
  const memoryControl = getAgentGroupMemoryControl(group.id);
  if (!memoryControl) throw new Error(`Memory control not found for agent group: ${group.id}`);
  config.agentProfile = buildAgentProfile(group, config, { memoryControl, sessionId });
  if (effective.profile && effective.profile.protocol !== 'native') {
    config.requestSystemInstructions = buildRequestSystemInstructions(group, config);
  }
  const runtimePath = path.join(sessionDir, 'container.runtime.json');
  const tempPath = `${runtimePath}.${process.pid}.tmp`;
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(tempPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tempPath, runtimePath);
  fs.chmodSync(runtimePath, 0o600);
  return { config, path: runtimePath };
}

/**
 * Materialize `container.json` from the DB. Called at spawn time so the
 * container always sees fresh config. Returns the `ContainerConfig` for
 * use by the caller (buildMounts, buildContainerArgs, etc.).
 */
export function materializeContainerJson(agentGroupId: string): ContainerConfig {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`Container config not found for agent group: ${agentGroupId}`);

  const config = configFromDb(row, group);

  const p = path.join(GROUPS_DIR, group.folder, 'container.json');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writePrivateFileSync(p, JSON.stringify(config, null, 2) + '\n');

  return config;
}
