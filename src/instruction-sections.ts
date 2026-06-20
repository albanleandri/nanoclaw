import fs from 'fs';
import path from 'path';

import type { AgentProfile } from './agent-profile.js';

const RUNTIME_CONTRACT_CONTAINER_PATH = '/app/CLAUDE.md';
const SHARED_SKILLS_CONTAINER_BASE = '/app/skills';
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

  for (const resource of [...profile.resources.sharedResources].sort()) {
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
  const sharedSkillsDir = path.join(projectRoot, 'container', 'skills');
  const customSkillsDir = path.join(sharedSkillsDir, 'custom');
  const available = new Map<string, SkillInstructionFragment>();

  function addSkill(name: string, hostDir: string, containerBase: string): void {
    const hostFragment = path.join(hostDir, name, 'instructions.md');
    if (!fs.existsSync(hostFragment)) return;
    available.set(name, {
      name,
      containerPath: `${containerBase}/${name}/instructions.md`,
    });
  }

  if (fs.existsSync(sharedSkillsDir)) {
    for (const entry of fs.readdirSync(sharedSkillsDir)) {
      if (entry === 'custom') continue;
      try {
        if (fs.statSync(path.join(sharedSkillsDir, entry)).isDirectory()) {
          addSkill(entry, sharedSkillsDir, SHARED_SKILLS_CONTAINER_BASE);
        }
      } catch {
        /* skip unreadable skill entries */
      }
    }
  }

  if (fs.existsSync(customSkillsDir)) {
    for (const entry of fs.readdirSync(customSkillsDir)) {
      try {
        if (fs.statSync(path.join(customSkillsDir, entry)).isDirectory()) {
          addSkill(entry, customSkillsDir, `${SHARED_SKILLS_CONTAINER_BASE}/custom`);
        }
      } catch {
        /* skip unreadable custom skill entries */
      }
    }
  }

  const names = selection === 'all' ? [...available.keys()] : selection;
  return names
    .map((name) => available.get(name))
    .filter((fragment): fragment is SkillInstructionFragment => fragment !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}
