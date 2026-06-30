import fs from 'fs';
import path from 'path';

import { getContainerConfig } from '../../db/container-configs.js';
import {
  approveSkill,
  getSkillInstallation,
  listSkillInstallations,
  setSkillState,
} from '../../db/skill-provenance.js';
import { DATA_DIR } from '../../config.js';
import { discoverSkillCatalog } from '../../skills/catalog.js';
import type { CallerContext } from '../frame.js';
import { registerResource } from '../crud.js';

function requireGlobal(ctx: CallerContext): string {
  if (ctx.caller === 'host') return 'host';
  if (getContainerConfig(ctx.agentGroupId)?.cli_scope !== 'global') {
    throw new Error('Skill provenance changes require global CLI scope');
  }
  return `agent:${ctx.agentGroupId}`;
}

function catalog() {
  return discoverSkillCatalog(process.cwd());
}

registerResource({
  name: 'skill',
  plural: 'skills',
  table: 'skill_installations',
  description: 'Installed skill provenance, compatibility, approval, and content drift.',
  idColumn: 'name',
  columns: [{ name: 'name', type: 'string', description: 'Effective skill name.' }],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List effective skills and provenance state; secret values are never shown.',
      handler: async () =>
        [...catalog().values()].map((entry) => {
          const installation = entry.manifest ? getSkillInstallation(entry.name) : undefined;
          return {
            name: entry.name,
            source_root: entry.sourceRoot,
            source_id: entry.manifest?.source.id ?? null,
            manifest_version: entry.manifest?.version ?? null,
            observed_hash: entry.hash ? entry.hash.slice(0, 12) : null,
            state: entry.error
              ? 'invalid'
              : entry.manifest
                ? (installation?.state ?? 'unapproved')
                : 'instruction-only',
            required_capabilities: entry.manifest?.requiresCapabilities ?? [],
            compatible_runtime_ids: entry.manifest?.compatibleRuntimeIds ?? [],
            error: entry.error ?? null,
          };
        }),
    },
    audit: {
      access: 'open',
      description: 'Re-hash manifests and report invalid, unapproved, or drifted active skills.',
      handler: async (_args, ctx) => {
        requireGlobal(ctx);
        const report = [...catalog().values()].map((entry) => {
          const installation = entry.manifest ? getSkillInstallation(entry.name) : undefined;
          const state = !entry.manifest
            ? 'instruction-only'
            : !installation
              ? 'unapproved'
              : installation.state === 'disabled' || installation.state === 'quarantined'
                ? installation.state
                : installation.approved_hash === entry.hash
                  ? 'active'
                  : 'drifted';
          return {
            name: entry.name,
            hash: entry.hash,
            state: entry.error ? 'invalid' : state,
            error: entry.error ?? null,
          };
        });
        const blockers = report.filter((entry) => entry.state === 'invalid' || entry.state === 'drifted');
        if (blockers.length) {
          throw new Error(`Skill audit failed: ${blockers.map((entry) => `${entry.name}:${entry.state}`).join(', ')}`);
        }
        return report;
      },
    },
    approve: {
      access: 'approval',
      description: 'Approve the currently observed content hash. Use --name.',
      handler: async (args, ctx) => {
        const actor = requireGlobal(ctx);
        const entry = catalog().get(String(args.name ?? ''));
        if (!entry) throw new Error(`Skill not found: ${String(args.name)}`);
        return approveSkill(entry, actor);
      },
    },
    disable: {
      access: 'approval',
      description: 'Disable an installed manifested skill. Use --name.',
      handler: async (args, ctx) => setSkillState(String(args.name ?? ''), 'disabled', requireGlobal(ctx)),
    },
    quarantine: {
      access: 'approval',
      description: 'Quarantine an installed manifested skill. Use --name.',
      handler: async (args, ctx) => setSkillState(String(args.name ?? ''), 'quarantined', requireGlobal(ctx)),
    },
    'promote-draft': {
      access: 'approval',
      description: 'Promote an unmounted data/skill-drafts entry into container/skills. Use --name.',
      handler: async (args, ctx) => {
        const actor = requireGlobal(ctx);
        const name = String(args.name ?? '');
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('Invalid draft skill name');
        const source = path.join(DATA_DIR, 'skill-drafts', name);
        const target = path.join(process.cwd(), 'container', 'skills', name);
        if (!fs.existsSync(source)) throw new Error(`Skill draft not found: ${name}`);
        if (fs.existsSync(target)) throw new Error(`Active skill already exists: ${name}`);
        fs.cpSync(source, target, { recursive: true, errorOnExist: true });
        const entry = catalog().get(name);
        if (!entry || entry.error || !entry.manifest) {
          fs.rmSync(target, { recursive: true, force: true });
          throw new Error(`Promoted skill is invalid: ${entry?.error ?? 'missing manifest'}`);
        }
        return approveSkill(entry, actor);
      },
    },
    installations: {
      access: 'open',
      description: 'List persisted manifested skill approval state.',
      handler: async (_args, ctx) => {
        requireGlobal(ctx);
        return listSkillInstallations();
      },
    },
  },
});
