import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { closeDb, initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { reindexSessionSearch } from '../src/session-search/reindex.js';

const dryRun = process.argv.includes('--dry-run');
const db = initDb(path.join(DATA_DIR, 'v2.db'));
try {
  runMigrations(db);
  process.stdout.write(`${JSON.stringify(reindexSessionSearch({ dryRun }), null, 2)}\n`);
} finally {
  closeDb();
}
