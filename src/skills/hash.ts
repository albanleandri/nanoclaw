import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function hashSkillDirectory(skillDir: string): string {
  if (fs.lstatSync(skillDir).isSymbolicLink()) throw new Error('Unsafe skill root: symbolic link');
  const root = fs.realpathSync(skillDir);
  const files: string[] = [];
  function walk(dir: string): void {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === '.provenance.json') continue;
      const absolute = path.join(dir, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw new Error(`Unsafe skill entry: ${path.relative(root, absolute)}`);
      }
      if (stat.isDirectory()) walk(absolute);
      else files.push(absolute);
    }
  }
  walk(root);
  const hash = createHash('sha256');
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`Skill file exceeds 2 MiB: ${relative}`);
    const bytes = fs.readFileSync(file);
    hash.update(`${relative}\0${stat.mode & 0o111 ? 'executable' : 'regular'}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}
