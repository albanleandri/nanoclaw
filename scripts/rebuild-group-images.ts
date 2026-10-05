/**
 * Rebuild every per-agent-group image on top of the freshly built base image.
 *
 * Groups with apt/npm packages run `<base>:<group-id>`, built FROM the base
 * image at the time. Rebuilding only the base left those groups on the old
 * runtime: after the Claude Code 2.1.197 -> 2.1.285 bump, Pinova Claude and
 * Pinova Codex kept 2.1.197 until each was rebuilt by hand. Called by
 * `container/build.sh` after a default (`latest`) base build.
 *
 * Does not restart anything: running containers keep their image until their
 * next start. Skips cleanly when there is no central DB yet (fresh install).
 *
 * Usage: pnpm exec tsx scripts/rebuild-group-images.ts
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { buildAgentGroupImage } from '../src/container-runner.js';
import { getDb, initDb } from '../src/db/connection.js';

export function groupsNeedingImages(
  rows: Array<{ agent_group_id: string; packages_apt: string; packages_npm: string }>,
): string[] {
  const nonEmpty = (json: string): boolean => {
    try {
      const value: unknown = JSON.parse(json);
      return Array.isArray(value) && value.length > 0;
    } catch (err) {
      if (err instanceof SyntaxError) return false;
      throw err;
    }
  };
  return rows.filter((r) => nonEmpty(r.packages_apt) || nonEmpty(r.packages_npm)).map((r) => r.agent_group_id);
}

async function main(): Promise<void> {
  const dbPath = path.join(DATA_DIR, 'v2.db');
  if (!fs.existsSync(dbPath)) {
    console.log('No central DB yet; no per-group images to rebuild.');
    return;
  }
  initDb(dbPath);
  const rows = getDb()
    .prepare('SELECT agent_group_id, packages_apt, packages_npm FROM container_configs')
    .all() as Array<{ agent_group_id: string; packages_apt: string; packages_npm: string }>;
  const ids = groupsNeedingImages(rows);
  if (ids.length === 0) {
    console.log('No agent group has its own image.');
    return;
  }
  let failed = 0;
  for (const id of ids) {
    console.log(`Rebuilding per-group image for ${id}...`);
    try {
      await buildAgentGroupImage(id);
      // eslint-disable-next-line no-catch-all/no-catch-all -- one failed group must not stop the others; reported below
    } catch (err) {
      failed++;
      console.error(`Failed to rebuild image for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed} per-group image(s) failed; those groups still run their previous image.`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
