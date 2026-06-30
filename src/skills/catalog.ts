import fs from 'fs';
import path from 'path';

import { hashSkillDirectory } from './hash.js';
import { validateSkillManifest, type SkillManifest } from './manifest.js';

export interface SkillCatalogEntry {
  name: string;
  directory: string;
  containerPath: string;
  sourceRoot: 'builtin' | 'custom';
  hash: string;
  manifest?: SkillManifest;
  error?: string;
}

export function discoverSkillCatalog(projectRoot: string): Map<string, SkillCatalogEntry> {
  const root = path.join(projectRoot, 'container', 'skills');
  const entries = new Map<string, SkillCatalogEntry>();
  function add(directory: string, sourceRoot: 'builtin' | 'custom'): void {
    if (!fs.existsSync(directory)) return;
    for (const dirent of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
      const skillDir = path.join(directory, dirent.name);
      if (!fs.existsSync(path.join(skillDir, 'SKILL.md')) && !fs.existsSync(path.join(skillDir, 'instructions.md')))
        continue;
      try {
        const manifestPath = path.join(skillDir, 'skill.json');
        const manifest = fs.existsSync(manifestPath)
          ? validateSkillManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
          : undefined;
        if (manifest && manifest.name !== dirent.name) throw new Error('Manifest name does not match directory');
        entries.set(dirent.name, {
          name: dirent.name,
          directory: skillDir,
          containerPath: sourceRoot === 'custom' ? `/app/skills/custom/${dirent.name}` : `/app/skills/${dirent.name}`,
          sourceRoot,
          hash: hashSkillDirectory(skillDir),
          manifest,
        });
      } catch (error) {
        entries.set(dirent.name, {
          name: dirent.name,
          directory: skillDir,
          containerPath: sourceRoot === 'custom' ? `/app/skills/custom/${dirent.name}` : `/app/skills/${dirent.name}`,
          sourceRoot,
          hash: '',
          error: error instanceof Error ? error.message : 'Invalid skill',
        });
      }
    }
  }
  add(root, 'builtin');
  add(path.join(root, 'custom'), 'custom');
  return entries;
}
