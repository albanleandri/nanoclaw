#!/usr/bin/env node
// Safely back up SQLite databases using the better-sqlite3 online backup API.
// Safe to run while NanoClaw is live — backup() holds no exclusive lock.
//
// Usage: node scripts/backup-dbs.mjs --dest <dir> <db1.db> [db2.db ...]

import Database from 'better-sqlite3';
import { mkdir, access } from 'fs/promises';
import path from 'path';

const args = process.argv.slice(2);
const destIdx = args.indexOf('--dest');

if (destIdx === -1 || !args[destIdx + 1]) {
  console.error('Usage: backup-dbs.mjs --dest <dir> <db1.db> [db2.db ...]');
  process.exit(1);
}

const dest = args[destIdx + 1];
const sources = args.filter((a, i) => a !== '--dest' && args[i - 1] !== '--dest');

if (sources.length === 0) {
  console.error('No database files specified.');
  process.exit(1);
}

await mkdir(dest, { recursive: true });

let failed = 0;
for (const src of sources) {
  try {
    await access(src);
  } catch {
    console.warn(`SKIP: ${src} (not found)`);
    continue;
  }

  const destPath = path.join(dest, path.basename(src));
  try {
    const db = new Database(src, { readonly: true, fileMustExist: true });
    await db.backup(destPath);
    db.close();
    console.log(`OK: ${src} -> ${destPath}`);
  } catch (err) {
    console.error(`FAIL: ${src}: ${err.message}`);
    failed++;
  }
}

if (failed > 0) {
  process.exit(1);
}
