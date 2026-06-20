import fs from 'fs';
import path from 'path';

/**
 * Resolve the shared resources that actually exist on the host and can be
 * mounted into a container, mapping each resource name to its container path.
 *
 * Backing mounts (see container-runner.ts `buildMounts`):
 *   - every directory under `groups/shared/<name>` → `/app/shared/<name>`
 *   - the repo `docs/` tree → `/app/docs` (exposed as the `docs` resource)
 *
 * This is the single source of truth for "which shared resources resolve".
 * Both the symlink sync (container-runner.ts) and the instruction composer
 * (instruction-sections.ts) consume it so they cannot drift — a resource is
 * only ever advertised to the agent if its mount will actually be present.
 */
export function resolveAvailableSharedResources(projectRoot: string): Map<string, string> {
  const available = new Map<string, string>();

  const sharedResourcesRoot = path.join(projectRoot, 'groups', 'shared');
  if (fs.existsSync(sharedResourcesRoot)) {
    for (const entry of fs.readdirSync(sharedResourcesRoot)) {
      try {
        if (fs.statSync(path.join(sharedResourcesRoot, entry)).isDirectory()) {
          available.set(entry, `/app/shared/${entry}`);
        }
      } catch {
        /* skip unreadable entries */
      }
    }
  }

  if (fs.existsSync(path.join(projectRoot, 'docs'))) {
    available.set('docs', '/app/docs');
  }

  return available;
}
