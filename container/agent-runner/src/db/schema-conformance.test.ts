/**
 * Container half of the session-DB contract.
 *
 * The host and the agent-runner communicate ONLY through inbound.db and
 * outbound.db (AGENTS.md), and each side hand-writes its own copy of the DDL —
 * the host in src/db/schema.ts, the container in initTestSessionDb(). Nothing
 * used to compare them, and they had already drifted: the fixture was missing
 * `session_routing` entirely, so getSessionRouting() silently fell through its
 * catch to all-null defaults and every routing-dependent test exercised the
 * degraded path instead of the real one.
 *
 * This asserts the fixture matches contracts/session-db-schema.json.
 * src/db/session-schema-conformance.test.ts asserts the host side against the
 * same file, so drift on either side fails CI.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';

import { closeSessionDb, initTestSessionDb } from './connection.js';
import { getSessionRouting } from './session-routing.js';

type TableColumns = Record<string, string[]>;
const contract = JSON.parse(
  readFileSync(new URL('../../../../contracts/session-db-schema.json', import.meta.url), 'utf8'),
) as { inbound: TableColumns; outbound: TableColumns };

function expectedTables(side: TableColumns): TableColumns {
  return Object.fromEntries(Object.entries(side).filter(([name]) => !name.startsWith('$')));
}

function actualTables(db: { prepare: (sql: string) => { all: () => unknown[] } }): TableColumns {
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
}

describe('session DB schema conformance (container fixture)', () => {
  beforeEach(() => initTestSessionDb());
  afterEach(() => closeSessionDb());

  it('inbound fixture matches the checked-in contract', () => {
    const { inbound } = initTestSessionDb();
    expect(actualTables(inbound)).toEqual(expectedTables(contract.inbound));
  });

  it('outbound fixture matches the checked-in contract', () => {
    const { outbound } = initTestSessionDb();
    expect(actualTables(outbound)).toEqual(expectedTables(contract.outbound));
  });

  it('resolves real session routing rather than silently falling back to nulls', () => {
    const { inbound } = initTestSessionDb();
    inbound
      .prepare(
        `INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
         VALUES (1, 'telegram', 'chat-9', 'thread-9')`,
      )
      .run();

    expect(getSessionRouting()).toEqual({
      channel_type: 'telegram',
      platform_id: 'chat-9',
      thread_id: 'thread-9',
    });
  });

  it('returns null routing when the host has not written a routing row', () => {
    initTestSessionDb();
    expect(getSessionRouting()).toEqual({ channel_type: null, platform_id: null, thread_id: null });
  });
});
