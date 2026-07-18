import fs from 'fs';
import path from 'path';

import type { AgentProfile } from './agent-profile.js';
import { getSkillInstallation } from './db/skill-provenance.js';
import { resolveAvailableSharedResources } from './shared-resources.js';
import { discoverSkillCatalog, selectSkillCatalog } from './skills/catalog.js';

const RUNTIME_CONTRACT_HOST_SUBPATH = path.join('container', 'runtime', 'core.md');
const RUNTIME_APPENDIX_HOST_SUBPATHS: Record<string, string> = {
  claude: path.join('container', 'runtime', 'claude.md'),
};
const MCP_TOOLS_CONTAINER_BASE = '/app/src/mcp-tools';
const MCP_TOOLS_HOST_SUBPATH = path.join('container', 'agent-runner', 'src', 'mcp-tools');

export type InstructionSectionKind = 'runtime' | 'memory' | 'skill' | 'module' | 'mcp' | 'resource';

export interface InstructionSection {
  id: string;
  title: string;
  kind: InstructionSectionKind;
  content?: string;
  containerPath?: string;
  required?: boolean;
}

export interface CollectInstructionSectionsOptions {
  projectRoot: string;
  profile: AgentProfile;
  capabilityIds?: Iterable<string>;
  provider?: string;
}

const MODULE_CAPABILITIES: Record<string, string[]> = {
  core: ['nanoclaw.send-message'],
  interactive: ['nanoclaw.send-message'],
  scheduling: ['nanoclaw.schedule-task', 'nanoclaw.manage-jobs'],
  'self-mod': ['nanoclaw.self-modify'],
  agents: [
    'nanoclaw.manage-agents',
    'nanoclaw.request-agent-task',
    'nanoclaw.get-agent-task',
    'nanoclaw.cancel-agent-task',
    'nanoclaw.report-agent-task-progress',
    'nanoclaw.block-agent-task',
    'nanoclaw.complete-agent-task',
    'nanoclaw.fail-agent-task',
    'nanoclaw.publish-agent-task-artifact',
  ],
  cli: ['nanoclaw.cli'],
};

interface SkillInstructionFragment {
  name: string;
  containerPath: string;
}

export function collectInstructionSections(options: CollectInstructionSectionsOptions): InstructionSection[] {
  const { projectRoot, profile } = options;
  const capabilityIds = options.capabilityIds ? new Set(options.capabilityIds) : undefined;
  const runtimePaths = [
    path.join(projectRoot, RUNTIME_CONTRACT_HOST_SUBPATH),
    ...(options.provider && RUNTIME_APPENDIX_HOST_SUBPATHS[options.provider]
      ? [path.join(projectRoot, RUNTIME_APPENDIX_HOST_SUBPATHS[options.provider])]
      : []),
  ];
  const runtimeContent = runtimePaths
    .filter((runtimePath) => fs.existsSync(runtimePath))
    .map((runtimePath) => fs.readFileSync(runtimePath, 'utf8').trim())
    .filter(Boolean)
    .join('\n\n');
  const sections: InstructionSection[] = [
    {
      id: 'runtime-contract',
      title: 'NanoClaw Runtime Contract',
      kind: 'runtime',
      content: runtimeContent,
      required: true,
    },
  ];

  for (const fragment of collectSkillInstructionFragments(projectRoot, profile.tools.skills)) {
    sections.push({
      id: `skill-${fragment.name}`,
      title: `Skill: ${fragment.name}`,
      kind: 'skill',
      containerPath: fragment.containerPath,
    });
  }

  const mcpToolsHostDir = path.join(projectRoot, MCP_TOOLS_HOST_SUBPATH);
  if (fs.existsSync(mcpToolsHostDir)) {
    for (const entry of fs.readdirSync(mcpToolsHostDir).sort()) {
      const match = entry.match(/^(.+)\.instructions\.md$/);
      if (!match) continue;
      const moduleName = match[1];
      if (moduleName === 'cli' && profile.tools.cliScope === 'disabled') continue;
      const requiredCapabilities = MODULE_CAPABILITIES[moduleName];
      if (capabilityIds && requiredCapabilities && !requiredCapabilities.some((id) => capabilityIds.has(id))) {
        continue;
      }
      sections.push({
        id: `module-${moduleName}`,
        title: `NanoClaw Module: ${moduleName}`,
        kind: 'module',
        containerPath: `${MCP_TOOLS_CONTAINER_BASE}/${entry}`,
      });
    }
  }

  for (const [name, mcp] of Object.entries(profile.tools.mcpServers).sort(([a], [b]) => a.localeCompare(b))) {
    if (!mcp.instructions) continue;
    sections.push({
      id: `mcp-${name}`,
      title: `MCP Server: ${name}`,
      kind: 'mcp',
      content: mcp.instructions,
    });
  }

  // Only advertise shared resources whose mount will actually be present in
  // the container. The resolver is the same one the symlink sync uses, so the
  // instruction and the mount cannot disagree.
  const availableResources = resolveAvailableSharedResources(projectRoot);
  for (const resource of [...profile.resources.sharedResources].sort()) {
    if (!availableResources.has(resource)) continue;
    sections.push({
      id: `resource-${resource}`,
      title: `Shared Resource: ${resource}`,
      kind: 'resource',
      content: `Shared resource \`${resource}\` is available at \`${profile.memory.workspacePath}/shared/${resource}\`.`,
    });
  }

  return sections;
}

export function collectSkillInstructionFragments(
  projectRoot: string,
  selection: string[] | 'all',
): SkillInstructionFragment[] {
  const catalog = discoverSkillCatalog(projectRoot);
  return selectSkillCatalog(catalog, selection)
    .entries.map((entry) => {
      const name = entry.name;
      if (entry.error || !fs.existsSync(path.join(entry.directory, 'instructions.md'))) return undefined;
      if (entry.manifest) {
        let installation;
        try {
          installation = getSkillInstallation(name);
        } catch {
          return undefined;
        }
        if (!installation || installation.state !== 'active' || installation.approved_hash !== entry.hash) {
          return undefined;
        }
      }
      return { name, containerPath: `${entry.containerPath}/instructions.md` };
    })
    .filter((fragment): fragment is SkillInstructionFragment => Boolean(fragment))
    .sort((a, b) => a.name.localeCompare(b.name));
}
