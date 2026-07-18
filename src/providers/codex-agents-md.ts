/**
 * AGENTS.md composition for codex agent groups — codex-owned payload code.
 *
 * AGENTS.md is Codex's project doc (its CLAUDE.md equivalent). Composed fresh
 * on every spawn by the codex provider contribution (see ./codex.ts) from:
 *   - the shared NanoClaw runtime contract
 *   - a pointer to the runner-scaffolded memory system (created container-side
 *     at boot via the `usesMemoryScaffold` capability — nothing is written here)
 *   - a pointer to codex-native skills under `.agents/skills`
 *   - each enabled NanoClaw module's `*.instructions.md` fragment
 *   - MCP server `instructions` from container.json
 *   - provider-neutral resource pointers from the agent profile
 *
 * Codex hard-caps project-doc loading (`project_doc_max_bytes`, mirrored in
 * the container provider's config.toml writer) — compose degrades explicitly
 * rather than letting Codex truncate silently.
 */
import fs from 'fs';
import path from 'path';

import { buildAgentProfile } from '../agent-profile.js';
import { configFromDb, type ContainerConfig } from '../container-config.js';
import { getContainerConfig } from '../db/container-configs.js';
import { collectInstructionSections, type InstructionSection } from '../instruction-sections.js';
import { log } from '../log.js';
import type { AgentGroup } from '../types.js';

export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;
export const CODEX_PROJECT_DOC_WARN_BYTES = 28 * 1024;

const HEADER = '<!-- Composed at spawn. Do not edit. Edit memory/system/definition.md for memory behavior. -->';
const MCP_TOOLS_CONTAINER_PREFIX = '/app/src/mcp-tools/';
const MCP_TOOLS_HOST_SUBPATH = path.join('container', 'agent-runner', 'src', 'mcp-tools');

const MEMORY_POINTER = [
  'Editable memory-system definition: `/workspace/agent/memory/system/definition.md`.',
  'Top memory index: `/workspace/agent/memory/index.md`.',
  'Read the definition and index, then use memories, data, and conversation archives when relevant.',
  'Stored user preferences are binding: before your first reply in a session, check the index below and read any memory file relevant to the user or the request, and apply it without being asked.',
  'Do not use `AGENTS.local.md` or `AGENTS.override.md` for memory.',
].join('\n\n');

/**
 * Inline the group's current memory index into the composed doc. Recall must
 * not depend on the model choosing to read a file before its first reply —
 * with the map already in the system prompt, applying a stored preference is
 * one hop (read the relevant memory file), not three. The index is small
 * (hundreds of bytes); the 32KB fit logic above bounds the worst case.
 */
function memoryIndexInline(groupDir: string): string {
  const indexPath = path.join(groupDir, 'memory', 'index.md');
  if (!fs.existsSync(indexPath)) return '';
  const content = fs.readFileSync(indexPath, 'utf-8').trim();
  if (!content) return '';
  return ['Current memory index (paths relative to `/workspace/agent/memory/`):', content].join('\n\n');
}

const NATIVE_RUNTIME_SKILLS_POINTER = [
  'Selected NanoClaw runtime skills are available as Codex-native skills at `/workspace/agent/.agents/skills`.',
  'Each skill directory contains a `SKILL.md` with its trigger description plus any supporting files, and points to the read-only shared skill source under `/app/skills`.',
  'Use skill discovery to load these skills only when their descriptions match the task. Full skill instructions live in the skill directories, not in `AGENTS.md`.',
  'Skills YOU author or install yourself go in `/workspace/agent/skills/<name>/SKILL.md` — persistent, provider-neutral (they load under any agent provider this group runs on), and yours to write and update over time. They are linked into `$CODEX_HOME/skills` automatically at boot. Never write skills anywhere else: paths outside your workspace and `$CODEX_HOME` are ephemeral.',
].join('\n\n');

interface AgentsMdSection {
  name: string;
  content: string;
}

export function composeGroupAgentsMd(
  group: AgentGroup,
  groupDir: string,
  options: { outputDir?: string; containerConfig?: ContainerConfig } = {},
): void {
  const outputDir = options.outputDir ?? groupDir;
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const projectRoot = process.cwd();
  const configRow = options.containerConfig ? undefined : getContainerConfig(group.id);
  const containerConfig =
    options.containerConfig ?? (configRow ? configFromDb(configRow, group) : defaultContainerConfig(group));
  const profile = buildAgentProfile(group, containerConfig);
  const instructionSections = collectInstructionSections({
    projectRoot,
    profile,
    provider: 'codex',
    capabilityIds: containerConfig.sessionRuntimePlan?.capabilities.map((item) => item.id),
  });

  const sections: AgentsMdSection[] = [{ name: 'header', content: HEADER }];
  const pushSection = (name: string, ...content: string[]): void => {
    const body = content
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n');
    if (body) sections.push({ name, content: `# ${name}\n\n${body}` });
  };

  const runtimeContent = readRuntimeContract(instructionSections);
  if (runtimeContent) pushSection('NanoClaw Runtime Contract', runtimeContent);

  pushSection('Memory System', MEMORY_POINTER, memoryIndexInline(groupDir));
  pushSection('Native Runtime Skills', NATIVE_RUNTIME_SKILLS_POINTER);

  for (const section of instructionSections) {
    if (section.kind === 'runtime' || section.kind === 'skill') continue;
    const content = readInstructionSectionContent(projectRoot, section);
    if (content) pushSection(section.title, content);
  }

  const content = fitAgentsMdToCap(group, sections);
  writeAtomic(path.join(outputDir, 'AGENTS.md'), content);
}

function readRuntimeContract(sections: InstructionSection[]): string {
  const runtimeSection = sections.find((section) => section.kind === 'runtime');
  return runtimeSection?.content ?? '';
}

function readInstructionSectionContent(projectRoot: string, section: InstructionSection): string {
  if (section.content) return section.content;
  if (section.kind !== 'module' || !section.containerPath?.startsWith(MCP_TOOLS_CONTAINER_PREFIX)) return '';

  const fileName = section.containerPath.slice(MCP_TOOLS_CONTAINER_PREFIX.length);
  const hostPath = path.join(projectRoot, MCP_TOOLS_HOST_SUBPATH, fileName);
  if (!fs.existsSync(hostPath)) return '';
  return fs.readFileSync(hostPath, 'utf-8');
}

function renderAgentsMd(sections: AgentsMdSection[]): string {
  return (
    sections
      .map((section) => section.content.trim())
      .filter(Boolean)
      .join('\n\n') + '\n'
  );
}

/**
 * Fit the doc under Codex's 32KB project-doc cap by DEGRADING, never
 * throwing: a per-spawn throw rides wakeContainer's transient-retry contract
 * — host-sweep respawns every 60s forever and the group goes silently dark.
 * Instead, drop the largest optional instruction sections (per-module and
 * per-MCP-server) until the doc fits, log what was dropped at error level,
 * and tell the agent in the doc itself. The core contract (header, runtime
 * contract, memory, skills pointer) is never dropped.
 */
function fitAgentsMdToCap(group: AgentGroup, sections: AgentsMdSection[]): string {
  const sectionBytes = (): { section: string; bytes: number }[] =>
    sections.map((section) => ({ section: section.name, bytes: Buffer.byteLength(section.content, 'utf-8') }));

  const isDroppable = (s: AgentsMdSection): boolean =>
    s.name.startsWith('MCP Server: ') || s.name.startsWith('NanoClaw Module: ');

  const dropped: string[] = [];
  const render = (): string => {
    const parts = [...sections];
    if (dropped.length > 0) {
      parts.push({
        name: 'omitted',
        content:
          `# Omitted for size\n\nThese instruction sections were omitted to fit Codex's project-doc cap: ` +
          `${dropped.join(', ')}. Their tools still work; consult each tool's own description.`,
      });
    }
    return renderAgentsMd(parts);
  };

  let content = render();
  while (Buffer.byteLength(content, 'utf-8') > CODEX_PROJECT_DOC_MAX_BYTES) {
    const candidates = sections
      .filter(isDroppable)
      .sort((a, b) => Buffer.byteLength(b.content, 'utf-8') - Buffer.byteLength(a.content, 'utf-8'));
    if (candidates.length === 0) break; // only core left — write oversized rather than brick the group
    sections.splice(sections.indexOf(candidates[0]), 1);
    dropped.push(candidates[0].name);
    content = render();
  }

  const bytes = Buffer.byteLength(content, 'utf-8');
  log.info('Composed Codex instruction context', {
    group: group.name,
    bytes,
    estimatedTokens: Math.ceil(bytes / 4),
    sections: sectionBytes(),
    dropped,
  });
  if (dropped.length > 0) {
    log.error('AGENTS.md exceeded Codex project-doc cap — dropped largest instruction sections', {
      group: group.name,
      bytes,
      maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
      dropped,
      sections: sectionBytes(),
    });
  } else if (bytes >= CODEX_PROJECT_DOC_WARN_BYTES) {
    log.warn('AGENTS.md is near Codex project-doc cap', {
      group: group.name,
      bytes,
      warnBytes: CODEX_PROJECT_DOC_WARN_BYTES,
      maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
      sections: sectionBytes(),
    });
  }
  return content;
}

function defaultContainerConfig(group: AgentGroup): ContainerConfig {
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    sharedResources: [],
    cliScope: 'group',
    groupName: group.name,
    assistantName: group.name,
    agentGroupId: group.id,
  };
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}
