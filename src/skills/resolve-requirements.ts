import { getSkillInstallation, observeSkill } from '../db/skill-provenance.js';
import { discoverSkillCatalog, selectSkillCatalog } from './catalog.js';

export interface SkillRequirements {
  requiredCapabilities: string[];
  optionalCapabilities: string[];
  skippedSkills: string[];
  effectiveSkills: string[];
}

export function resolveSkillRequirements(input: {
  projectRoot: string;
  selection: string[] | 'all';
  runtimeId: string;
  availableConfig?: ReadonlySet<string>;
  availableSecrets?: ReadonlySet<string>;
}): SkillRequirements {
  const catalog = discoverSkillCatalog(input.projectRoot);
  const selection = selectSkillCatalog(catalog, input.selection);
  const required = new Set<string>();
  const optional = new Set<string>();
  const skipped = new Set<string>();
  const config = input.availableConfig ?? new Set(Object.keys(process.env));
  const secrets = input.availableSecrets ?? new Set(Object.keys(process.env));
  for (const name of selection.skippedSkills) skipped.add(name);
  for (const entry of selection.entries) {
    const name = entry.name;
    if (entry.error) throw new Error(`Selected skill ${name} is invalid: ${entry.error}`);
    if (!entry.manifest) continue;
    const observed = observeSkill(entry);
    const installation = observed ?? getSkillInstallation(name);
    if (!installation || installation.state !== 'active' || installation.approved_hash !== entry.hash) {
      throw new Error(
        `Selected skill ${name} is ${installation?.state ?? 'unapproved'} (hash ${entry.hash.slice(0, 12)})`,
      );
    }
    if (entry.manifest.compatibleRuntimeIds && !entry.manifest.compatibleRuntimeIds.includes(input.runtimeId)) {
      throw new Error(`Selected skill ${name} is incompatible with runtime ${input.runtimeId}`);
    }
    for (const key of entry.manifest.requiredConfig ?? []) {
      if (!config.has(key)) throw new Error(`Selected skill ${name} requires configuration ${key}`);
    }
    for (const key of entry.manifest.requiredSecrets ?? []) {
      if (!secrets.has(key)) throw new Error(`Selected skill ${name} requires secret assignment ${key}`);
    }
    for (const id of entry.manifest.requiresCapabilities) required.add(id);
    for (const id of entry.manifest.optionalCapabilities ?? []) optional.add(id);
  }
  return {
    requiredCapabilities: [...required].sort(),
    optionalCapabilities: [...optional].sort(),
    skippedSkills: [...skipped].sort(),
    effectiveSkills: selection.entries.map((entry) => entry.name),
  };
}
