/**
 * Host half of the session-DB contract.
 *
 * inbound.db / outbound.db are the only channel between the host and the
 * agent-runner (AGENTS.md), and the DDL is written twice — authoritatively
 * here in src/db/schema.ts, and again in the container's initTestSessionDb().
 * Both sides assert against contracts/session-db-schema.json so a column added
 * on one side without the other fails CI instead of silently diverging.
 *
 * See container/agent-runner/src/db/schema-conformance.test.ts for the twin.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';

type TableColumns = Record<string, string[]>;
const contract = JSON.parse(
  readFileSync(new URL('../../contracts/session-db-schema.json', import.meta.url), 'utf8'),
) as { inbound: TableColumns; outbound: TableColumns };

function expectedTables(side: TableColumns): TableColumns {
  return Object.fromEntries(Object.entries(side).filter(([name]) => !name.startsWith('$')));
}

function introspect(schemaSql: string): TableColumns {
  const db = new Database(':memory:');
  try {
    db.exec(schemaSql);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((row) => row.name)
      .filter((name) => !name.startsWith('sqlite_'));
    const out: TableColumns = {};
    for (const name of names.sort()) {
      out[name] = (db.prepare(`PRAGMA table_info('${name}')`).all() as Array<{ name: string }>)
        .map((col) => col.name)
        .sort();
    }
    return out;
  } finally {
    db.close();
  }
}

describe('session DB schema conformance (host authoritative DDL)', () => {
  it('inbound schema matches the checked-in contract', () => {
    expect(introspect(INBOUND_SCHEMA)).toEqual(expectedTables(contract.inbound));
  });

  it('outbound schema matches the checked-in contract', () => {
    expect(introspect(OUTBOUND_SCHEMA)).toEqual(expectedTables(contract.outbound));
  });

  it('keeps the contract non-empty so a parse regression cannot vacuously pass', () => {
    expect(Object.keys(expectedTables(contract.inbound)).length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(expectedTables(contract.outbound)).length).toBeGreaterThanOrEqual(4);
  });
});
