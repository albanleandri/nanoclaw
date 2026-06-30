import fs from 'fs';
import path from 'path';

import type { AgentProfile } from './agent-profile.js';
import { getSkillInstallation } from './db/skill-provenance.js';
import { resolveAvailableSharedResources } from './shared-resources.js';
import { discoverSkillCatalog } from './skills/catalog.js';

const RUNTIME_CONTRACT_CONTAINER_PATH = '/app/CLAUDE.md';
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
}

interface SkillInstructionFragment {
  name: string;
  containerPath: string;
}

export function collectInstructionSections(options: CollectInstructionSectionsOptions): InstructionSection[] {
  const { projectRoot, profile } = options;
  const sections: InstructionSection[] = [
    {
      id: 'runtime-contract',
      title: 'NanoClaw Runtime Contract',
      kind: 'runtime',
      containerPath: RUNTIME_CONTRACT_CONTAINER_PATH,
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
  const names = selection === 'all' ? [...catalog.keys()] : selection;
  return names
    .map((name) => {
      const entry = catalog.get(name);
      if (!entry || entry.error || !fs.existsSync(path.join(entry.directory, 'instructions.md'))) return undefined;
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
