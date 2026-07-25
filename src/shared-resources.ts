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
        if (fs.lstatSync(path.join(sharedResourcesRoot, entry)).isDirectory()) {
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

export function hasSharedOkfRoot(projectRoot: string, resourceName: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(resourceName)) return false;
  const root = path.join(projectRoot, 'groups', 'shared', resourceName);
  try {
    return (
      fs.lstatSync(path.join(root, 'index.md')).isFile() &&
      fs.lstatSync(path.join(root, 'system')).isDirectory() &&
      fs.lstatSync(path.join(root, 'system', 'definition.md')).isFile()
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * Resolve a path that may be a group-workspace symlink whose target only exists
 * inside an agent container. Host jobs must use the backing host resource path.
 */
export function resolveHostPath(candidatePath: string, projectRoot: string = process.cwd()): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidatePath);
  } catch {
    return candidatePath;
  }
  if (!stat.isSymbolicLink()) return candidatePath;

  const target = fs.readlinkSync(candidatePath);
  const sharedPrefix = '/app/shared/';
  if (target.startsWith(sharedPrefix)) {
    const relative = target.slice(sharedPrefix.length);
    const resolved = path.resolve(projectRoot, 'groups', 'shared', relative);
    const sharedRoot = path.resolve(projectRoot, 'groups', 'shared');
    if (resolved !== sharedRoot && !resolved.startsWith(sharedRoot + path.sep)) {
      throw new Error(`shared-resource symlink escapes host backing root: ${candidatePath}`);
    }
    return resolved;
  }
  if (target === '/app/docs' || target.startsWith('/app/docs/')) {
    const relative = target === '/app/docs' ? '' : target.slice('/app/docs/'.length);
    const resolved = path.resolve(projectRoot, 'docs', relative);
    const docsRoot = path.resolve(projectRoot, 'docs');
    if (resolved !== docsRoot && !resolved.startsWith(docsRoot + path.sep)) {
      throw new Error(`docs symlink escapes host backing root: ${candidatePath}`);
    }
    return resolved;
  }
  if (!path.isAbsolute(target)) return path.resolve(path.dirname(candidatePath), target);
  throw new Error(`unsupported container-only symlink target for host job: ${target}`);
}
