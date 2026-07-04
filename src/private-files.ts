import fs from 'fs';
import path from 'path';

export const PRIVATE_FILE_MODE = 0o600;

/** Write a regular file without following a final-component symlink. */
export function writePrivateFileSync(filePath: string, data: string | NodeJS.ArrayBufferView): void {
  const fd = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Private file path is not a regular file: ${filePath}`);
    fs.fchmodSync(fd, PRIVATE_FILE_MODE);
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

function hardenPrivateFileIfPresent(filePath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing unsafe private file path: ${filePath}`);
  }
  fs.chmodSync(filePath, PRIVATE_FILE_MODE);
}

/**
 * Upgrade existing installations before adapters or containers start.
 * The legacy data/env/env copy has no runtime consumer and only duplicates
 * every host secret.
 */
export function hardenProjectSecretFiles(projectRoot: string): void {
  hardenPrivateFileIfPresent(path.join(projectRoot, '.env'));

  const legacyMirror = path.join(projectRoot, 'data', 'env', 'env');
  try {
    const stat = fs.lstatSync(legacyMirror);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error(`Refusing to remove non-file legacy environment mirror: ${legacyMirror}`);
    }
    fs.unlinkSync(legacyMirror);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const groupsDir = path.join(projectRoot, 'groups');
  if (!fs.existsSync(groupsDir)) return;
  for (const entry of fs.readdirSync(groupsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    hardenPrivateFileIfPresent(path.join(groupsDir, entry.name, 'container.json'));
  }
}
