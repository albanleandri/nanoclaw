/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← persistent agent workspace (provider-native docs, config, working files)
 *       container.json  ← per-group config + neutral agentProfile (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import { runPollLoop } from './poll-loop.js';
import { createProviderStateStore } from './db/session-state.js';
import { buildProtocolToolBroker } from './runtime-bootstrap.js';
import { initializeMemory, renderMemoryContext } from './memory/index.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;
  const memoryProfile = config.agentProfile?.memory;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  const memory = initializeMemory(memoryProfile);
  if (memoryProfile && memoryProfile.mode !== 'disabled') {
    log(
      `Memory initialized (mode: ${memoryProfile?.mode}, access: ${memoryProfile?.access}, index bytes: ${memory.indexBytes ?? 'unavailable'}, definition bytes: ${memory.definitionBytes ?? 'unavailable'}, warnings: ${memory.warnings.join(',') || 'none'})`,
    );
  }

  // Runtime-generated system-prompt addendum: agent identity (name) plus
  // the live destinations map. Provider-native project docs in the persistent
  // /workspace/agent workspace carry capabilities, module instructions, and
  // memory conventions for the selected provider.
  const runtimeAddendum = buildSystemPromptAddendum(config.assistantName || undefined);
  const instructions = config.requestSystemInstructions
    ? `${config.requestSystemInstructions}\n\n${runtimeAddendum}`
    : runtimeAddendum;

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  const grantedCapabilities = new Set(config.sessionRuntimePlan?.capabilities.map((item) => item.id) ?? []);

  // Build MCP servers config from the host-compiled capability plan. The
  // NanoClaw subprocess independently filters its tool catalog using the same
  // grant set, so a guessed tool call is rejected as well as omitted.
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: { NANOCLAW_CAPABILITIES: JSON.stringify([...grantedCapabilities]) },
    },
  };

  if (grantedCapabilities.has('nanoclaw.external-mcp')) {
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      mcpServers[name] = serverConfig;
      log(`Additional MCP server: ${name} (${serverConfig.command})`);
    }
  }

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
    model: config.model,
    effort: config.effort,
    runtimeStateKey: config.runtimeStateKey,
    providerProfile: config.providerProfile,
    stateStore: createProviderStateStore(config.runtimeStateKey ?? providerName),
    protocolToolBroker: buildProtocolToolBroker(config),
    memory: memoryProfile
      ? {
          enabled: memoryProfile.mode !== 'disabled',
          render: () => renderMemoryContext(memoryProfile).context,
        }
      : undefined,
  });

  await runPollLoop({
    provider,
    providerName,
    providerStateKey: config.runtimeStateKey,
    cwd: CWD,
    systemContext: { instructions },
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
