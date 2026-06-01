/**
 * scripts/q.ts — sqlite3 CLI replacement for skill SQL invocations.
 *
 * Usage:
 *   pnpm exec tsx scripts/q.ts [--readonly] [--limit N] <db-path> "<sql>"
 *
 * Uses better-sqlite3's stmt.reader property to distinguish queries
 * (SELECT / WITH...SELECT) from mutations. Queries print rows in
 * sqlite3 CLI default ("list") format — pipe-separated, no header —
 * so existing skill text reads identically. Mutations run via
 * stmt.run() (single statement) or db.exec() (compound).
 *
 * Read-only mode is the approved path for Codex database inspection. It
 * restricts DB paths to repo-owned DB directories, enables SQLite query_only,
 * accepts only SELECT/WITH/read-only PRAGMA statements, rejects compound SQL,
 * and caps output so accidental broad dumps fail with guidance.
 *
 * Why this exists: setup/verify.ts:5 codifies that NanoClaw avoids
 * depending on the sqlite3 CLI binary; setup never installs or probes
 * for it. Skills that shell out to `sqlite3` therefore fail on hosts
 * where it isn't preinstalled (common on fresh Ubuntu — see #2191).
 * This wrapper preserves the skill-text shape (path then SQL string)
 * while routing through the better-sqlite3 dep that setup already
 * installs and verifies.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';

const DEFAULT_READONLY_LIMIT = 5000;
const MAX_READONLY_LIMIT = 50000;
const READONLY_EXIT = 3;
const READONLY_LIMIT_EXIT = 4;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const readonlyDbRoots = [path.join(repoRoot, 'data'), path.join(repoRoot, 'groups')];
const readonlyPragmas = new Set([
  'database_list',
  'foreign_key_list',
  'index_info',
  'index_list',
  'index_xinfo',
  'integrity_check',
  'quick_check',
  'schema_version',
  'table_info',
  'table_xinfo',
  'user_version',
]);

function usage(): never {
  console.error('Usage: pnpm exec tsx scripts/q.ts [--readonly] [--limit N] <db-path> "<sql>"');
  process.exit(2);
}

function failReadonly(message: string): never {
  console.error(message);
  process.exit(READONLY_EXIT);
}

function parseArgs(argv: string[]): { readonly: boolean; limit: number; dbPath: string; sql: string } {
  const args = [...argv];
  let readonly = false;
  let limit = DEFAULT_READONLY_LIMIT;

  while (args[0]?.startsWith('--')) {
    const flag = args.shift();
    if (flag === '--readonly') {
      readonly = true;
    } else if (flag === '--limit') {
      const raw = args.shift();
      const parsed = raw === undefined ? NaN : Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_READONLY_LIMIT) {
        console.error(`--limit must be an integer between 1 and ${MAX_READONLY_LIMIT}`);
        process.exit(2);
      }
      limit = parsed;
    } else {
      usage();
    }
  }

  const [dbPath, sql] = args;
  if (!dbPath || sql === undefined || args.length !== 2) usage();
  return { readonly, limit, dbPath, sql };
}

function isUnder(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertReadonlyDbPath(dbPath: string): void {
  let realPath: string;
  try {
    realPath = fs.realpathSync(dbPath);
  } catch {
    failReadonly('--readonly database path must exist and stay inside data/ or groups/');
  }

  if (!readonlyDbRoots.some((root) => isUnder(realPath, fs.realpathSync(root)))) {
    failReadonly('--readonly database path is outside approved database directories: data/ and groups/');
  }
}

function stripTrailingSemicolons(sql: string): string {
  return sql
    .trim()
    .replace(/;+\s*$/u, '')
    .trim();
}

function readonlyStatementKind(sql: string): 'select' | 'with' | 'pragma' | 'other' {
  const trimmed = stripTrailingSemicolons(sql).replace(/^\s*(?:--[^\n]*\n\s*)+/u, '');
  const first = /^([a-z_]+)/iu.exec(trimmed)?.[1]?.toLowerCase();
  if (first === 'select') return 'select';
  if (first === 'with') return 'with';
  if (first === 'pragma') return 'pragma';
  return 'other';
}

function assertReadonlySql(sql: string): string {
  const stripped = stripTrailingSemicolons(sql);
  if (!stripped) failReadonly('--readonly requires a SQL statement');
  if (stripped.includes(';')) failReadonly('--readonly does not allow compound SQL statements');

  const kind = readonlyStatementKind(stripped);
  if (kind === 'select' || kind === 'with') return stripped;
  if (kind !== 'pragma') {
    failReadonly('--readonly only allows SELECT, WITH, or read-only PRAGMA statements');
  }

  const match = /^\s*pragma\s+(?:main\.|temp\.)?([a-z_]+)\s*(?:\(|$)/iu.exec(stripped);
  const pragmaName = match?.[1]?.toLowerCase();
  if (!pragmaName || !readonlyPragmas.has(pragmaName) || /=/.test(stripped)) {
    failReadonly('--readonly only allows SELECT, WITH, or read-only PRAGMA statements');
  }
  return stripped;
}

function printRows(stmt: Database.Statement, limit: number): void {
  let count = 0;
  for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
    if (count >= limit) {
      console.error(`Query returned more than ${limit} rows; narrow the query or pass --limit N.`);
      process.exitCode = READONLY_LIMIT_EXIT;
      return;
    }
    console.log(
      Object.values(row)
        .map((v) => (v === null ? '' : String(v)))
        .join('|'),
    );
    count += 1;
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.readonly) {
  assertReadonlyDbPath(args.dbPath);
  args.sql = assertReadonlySql(args.sql);
}

const db = new Database(args.dbPath, args.readonly ? { readonly: true, fileMustExist: true } : undefined);
try {
  if (args.readonly) db.pragma('query_only = ON');
  try {
    const stmt = db.prepare(args.sql);
    if (stmt.reader) {
      printRows(stmt, args.readonly ? args.limit : Number.MAX_SAFE_INTEGER);
    } else {
      if (args.readonly) {
        failReadonly('--readonly only allows SELECT, WITH, or read-only PRAGMA statements');
      }
      stmt.run();
    }
  } catch (e: unknown) {
    // better-sqlite3 throws on compound statements ("contains more than
    // one statement"). Compound SQL in skills is always mutations
    // (e.g. "DELETE ...; INSERT ...;"), so fall back to db.exec().
    if (e instanceof Error && /more than one statement/i.test(e.message)) {
      if (args.readonly) {
        failReadonly('--readonly does not allow compound SQL statements');
      }
      db.exec(args.sql);
    } else {
      throw e;
    }
  }
} finally {
  db.close();
}
