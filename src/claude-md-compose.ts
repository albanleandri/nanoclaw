/**
 * CLAUDE.md composition for agent groups.
 *
 * Replaces the per-group "written once at init, owned by the group" pattern
 * with a host-regenerated entry point that imports:
 *   - the provider-neutral runtime core and Claude appendix
 *   - optional per-skill fragments (skills that ship `instructions.md`)
 *   - optional per-MCP-server fragments (inline `instructions` field in
 *     `container.json`)
 *   - per-group agent memory (`CLAUDE.local.md`, auto-loaded by Claude Code)
 *
 * Runs on every spawn from `container-runner.buildMounts()`. Deterministic —
 * same inputs produce the same CLAUDE.md, and stale fragments are pruned.
 *
 * Fragments are copied in as regular files (never symlinks to /app/...): Claude
 * Code drops @-imports that resolve outside the project.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { configFromDb, type ContainerConfig } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { collectInstructionSections } from './instruction-sections.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';
import { buildAgentProfile } from './agent-profile.js';

export { collectSkillInstructionFragments } from './instruction-sections.js';

const COMPOSED_HEADER =
  '<!-- Composed at spawn — do not edit. Follow the runtime memory instructions for persistent content. -->';

/**
 * Regenerate a Claude project doc from the neutral runtime core, Claude
 * appendix, enabled skill fragments, and MCP server fragments. Creates an
 * empty `CLAUDE.local.md` only when composing into the persistent group dir.
 */
export function composeGroupClaudeMd(
  group: AgentGroup,
  options: { outputDir?: string; containerConfig?: ContainerConfig } = {},
): void {
  const groupDir = options.outputDir ?? path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
  }

  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (!fs.existsSync(fragmentsDir)) {
    fs.mkdirSync(fragmentsDir, { recursive: true });
  }

  const configRow = options.containerConfig ? undefined : getContainerConfig(group.id);
  const containerConfig =
    options.containerConfig ?? (configRow ? configFromDb(configRow, group) : defaultContainerConfig(group));
  const profile = containerConfig.agentProfile ?? buildAgentProfile(group, containerConfig);
  const desired = new Map<string, string>();
  const sectionBytes: Array<{ section: string; bytes: number }> = [];

  for (const section of collectInstructionSections({
    projectRoot: process.cwd(),
    profile,
    provider: 'claude',
    capabilityIds: containerConfig.sessionRuntimePlan?.capabilities.map((item) => item.id),
  })) {
    if (section.containerPath) {
      // Copy the fragment in rather than symlinking to /app/...: Claude Code
      // 2.1.2xx silently drops @-imports that resolve outside the project, so
      // a symlinked module manual or skill fragment never reached the model
      // (upstream 32689e7b fixes the same thing by inlining). Read from the
      // host source, which is what the container mounts at /app.
      const hostPath = section.containerPath
        .replace('/app/skills/', path.join(process.cwd(), 'container', 'skills') + path.sep)
        .replace(
          '/app/src/mcp-tools/',
          path.join(process.cwd(), 'container', 'agent-runner', 'src', 'mcp-tools') + path.sep,
        );
      if (!fs.existsSync(hostPath)) {
        log.warn('Instruction fragment source missing; skipping', { section: section.id, hostPath });
        continue;
      }
      const content = fs.readFileSync(hostPath, 'utf8');
      desired.set(section.id + '.md', content);
      sectionBytes.push({ section: section.id, bytes: Buffer.byteLength(content, 'utf8') });
    } else if (section.content) {
      desired.set(section.id + '.md', section.content);
      sectionBytes.push({ section: section.id, bytes: Buffer.byteLength(section.content, 'utf8') });
    }
  }

  // Reconcile: drop stale, write desired.
  for (const existing of fs.readdirSync(fragmentsDir)) {
    if (!desired.has(existing)) {
      fs.unlinkSync(path.join(fragmentsDir, existing));
    }
  }
  for (const [name, content] of desired) {
    // writeAtomic renames over the path, so a legacy symlink is replaced by a file.
    writeAtomic(path.join(fragmentsDir, name), content);
  }

  // Composed entry — imports only.
  const imports: string[] = [];
  for (const name of [...desired.keys()].sort()) {
    imports.push(`@./.claude-fragments/${name}`);
  }
  const body = [COMPOSED_HEADER, ...imports, ''].join('\n');
  writeAtomic(path.join(groupDir, 'CLAUDE.md'), body);
  const totalBytes = sectionBytes.reduce((sum, section) => sum + section.bytes, Buffer.byteLength(body, 'utf8'));
  log.info('Composed Claude instruction context', {
    group: group.name,
    bytes: totalBytes,
    estimatedTokens: Math.ceil(totalBytes / 4),
    sections: sectionBytes,
  });

  if (!options.outputDir) {
    const localFile = path.join(groupDir, 'CLAUDE.local.md');
    if (!fs.existsSync(localFile)) fs.writeFileSync(localFile, '');
  }
}

/**
 * One-time cutover from the `groups/global/CLAUDE.md` + `.claude-global.md`
 * pattern. Idempotent — safe to run on every host startup.
 *
 * For each group dir:
 *   - remove `.claude-global.md` symlink if present
 *   - rename `CLAUDE.md` → `CLAUDE.local.md` (only if `CLAUDE.local.md`
 *     doesn't already exist — preserves pre-cutover content as per-group
 *     memory; after the first spawn regenerates `CLAUDE.md`, this branch
 *     is skipped because `CLAUDE.local.md` now exists)
 *
 * Globally:
 *   - delete `groups/global/` (content moved into the managed runtime contract)
 */
export function migrateGroupsToClaudeLocal(): void {
  if (!fs.existsSync(GROUPS_DIR)) return;

  const actions: string[] = [];

  for (const entry of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'global') continue;

    const groupDir = path.join(GROUPS_DIR, entry.name);

    const oldGlobalLink = path.join(groupDir, '.claude-global.md');
    try {
      fs.lstatSync(oldGlobalLink);
      fs.unlinkSync(oldGlobalLink);
      actions.push(`${entry.name}/.claude-global.md removed`);
    } catch {
      /* already gone */
    }

    const claudeMd = path.join(groupDir, 'CLAUDE.md');
    const claudeLocal = path.join(groupDir, 'CLAUDE.local.md');
    if (fs.existsSync(claudeMd) && !fs.existsSync(claudeLocal)) {
      fs.renameSync(claudeMd, claudeLocal);
      actions.push(`${entry.name}/CLAUDE.md → CLAUDE.local.md`);
    }
  }

  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    fs.rmSync(globalDir, { recursive: true, force: true });
    actions.push('groups/global/ removed');
  }

  if (actions.length > 0) {
    log.info('Migrated groups to CLAUDE.local.md model', { actions });
  }
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = filePath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
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
