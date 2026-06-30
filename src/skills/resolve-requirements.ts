import { getSkillInstallation, observeSkill } from '../db/skill-provenance.js';
import { discoverSkillCatalog } from './catalog.js';

export interface SkillRequirements {
  requiredCapabilities: string[];
  optionalCapabilities: string[];
}

export function resolveSkillRequirements(input: {
  projectRoot: string;
  selection: string[] | 'all';
  runtimeId: string;
  availableConfig?: ReadonlySet<string>;
  availableSecrets?: ReadonlySet<string>;
}): SkillRequirements {
  const catalog = discoverSkillCatalog(input.projectRoot);
  const names = input.selection === 'all' ? [...catalog.keys()] : input.selection;
  const required = new Set<string>();
  const optional = new Set<string>();
  const config = input.availableConfig ?? new Set(Object.keys(process.env));
  const secrets = input.availableSecrets ?? new Set(Object.keys(process.env));
  for (const name of names) {
    const entry = catalog.get(name);
    if (!entry) throw new Error(`Selected skill is not installed: ${name}`);
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
  return { requiredCapabilities: [...required].sort(), optionalCapabilities: [...optional].sort() };
}
