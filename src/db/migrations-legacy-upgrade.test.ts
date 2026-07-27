/**
 * Legacy-upgrade coverage for the migration chain.
 *
 * db-v2.test.ts proves migrations are idempotent and that one populated
 * pre-orchestration DB survives the chain. What it does not do is exercise the
 * *data-dependent* branches inside individual migrations — the JSON backfills
 * and collision handling that only run when a real old install has rows in a
 * particular shape. Those branches were near-zero covered (22.6% across
 * src/db/migrations), which is exactly the code that runs once, on a user's
 * production database, with no second chance.
 *
 * Each test rewinds to the migration's predecessor, plants rows in the legacy
 * shape, then runs the rest of the chain and asserts the converted result.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, runMigrations } from './index.js';
import { migrations } from './migrations/index.js';

function upTo(name: string) {
  const index = migrations.findIndex((migration) => migration.name === name);
  if (index < 0) throw new Error(`no migration named ${name}`);
  return migrations.slice(0, index);
}

function now() {
  return '2026-01-01T00:00:00.000Z';
}

beforeEach(() => closeDb());
afterEach(() => closeDb());

describe('engage-modes migration — legacy trigger_rules backfill', () => {
  /**
   * Plant one messaging_group_agents row per legacy shape, run the chain, and
   * read back the four columns the migration derives.
   */
  function migrateRows(rows: Array<{ id: string; trigger_rules: string | null; response_scope: string | null }>) {
    const db = initTestDb();
    runMigrations(db, upTo('engage-modes'));

    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES ('ag-1', 'Agent', 'agent', NULL, ?)`,
    ).run(now());
    // (messaging_group_id, agent_group_id) is unique, so each wiring row needs
    // its own messaging group.
    const insertGroup = db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, created_at)
       VALUES (?, 'telegram', ?, 'Chat', 1, ?)`,
    );
    const insert = db.prepare(
      `INSERT INTO messaging_group_agents
         (id, messaging_group_id, agent_group_id, priority, session_mode, trigger_rules, response_scope, created_at)
       VALUES (?, ?, 'ag-1', 0, 'shared', ?, ?, ?)`,
    );
    for (const row of rows) {
      const groupId = `mg-${row.id}`;
      insertGroup.run(groupId, `chat-${row.id}`, now());
      insert.run(row.id, groupId, row.trigger_rules, row.response_scope, now());
    }

    runMigrations(db);

    return db
      .prepare(
        `SELECT id, engage_mode, engage_pattern, sender_scope, ignored_message_policy
           FROM messaging_group_agents ORDER BY id`,
      )
      .all() as Array<Record<string, string | null>>;
  }

  it('an explicit pattern becomes engage_mode=pattern with that pattern', () => {
    const [row] = migrateRows([
      { id: 'w1', trigger_rules: JSON.stringify({ pattern: '^hey bot' }), response_scope: null },
    ]);

    expect(row).toMatchObject({ engage_mode: 'pattern', engage_pattern: '^hey bot' });
  });

  it('requiresTrigger=false becomes the match-everything pattern', () => {
    const [row] = migrateRows([
      { id: 'w1', trigger_rules: JSON.stringify({ requiresTrigger: false }), response_scope: null },
    ]);

    expect(row).toMatchObject({ engage_mode: 'pattern', engage_pattern: '.' });
  });

  it('response_scope=all becomes the match-everything pattern', () => {
    const [row] = migrateRows([{ id: 'w1', trigger_rules: null, response_scope: 'all' }]);

    expect(row).toMatchObject({ engage_mode: 'pattern', engage_pattern: '.', sender_scope: 'all' });
  });

  it('a trigger with no pattern falls back to mention', () => {
    const [row] = migrateRows([
      { id: 'w1', trigger_rules: JSON.stringify({ requiresTrigger: true }), response_scope: null },
    ]);

    expect(row).toMatchObject({ engage_mode: 'mention', engage_pattern: null });
  });

  it('response_scope=allowlisted narrows sender_scope to known', () => {
    const [row] = migrateRows([{ id: 'w1', trigger_rules: null, response_scope: 'allowlisted' }]);

    expect(row).toMatchObject({ sender_scope: 'known', engage_mode: 'mention' });
  });

  it('invalid legacy JSON degrades to the conservative default, not a crash', () => {
    const [row] = migrateRows([{ id: 'w1', trigger_rules: '{not valid json', response_scope: null }]);

    expect(row).toMatchObject({ engage_mode: 'mention', engage_pattern: null, sender_scope: 'all' });
  });

  it('an empty-string pattern is treated as absent rather than as a regex', () => {
    // An empty pattern would match everything if it were kept — the migration
    // must not silently widen engagement.
    const [row] = migrateRows([{ id: 'w1', trigger_rules: JSON.stringify({ pattern: '' }), response_scope: null }]);

    expect(row).toMatchObject({ engage_mode: 'mention', engage_pattern: null });
  });

  it('always defaults ignored_message_policy to drop', () => {
    const rows = migrateRows([
      { id: 'w1', trigger_rules: JSON.stringify({ pattern: 'x' }), response_scope: 'all' },
      { id: 'w2', trigger_rules: null, response_scope: 'allowlisted' },
    ]);

    expect(rows.map((r) => r.ignored_message_policy)).toEqual(['drop', 'drop']);
  });

  it('drops the legacy columns once the backfill is done', () => {
    const db = initTestDb();
    runMigrations(db, upTo('engage-modes'));
    runMigrations(db);

    const cols = (db.prepare("PRAGMA table_info('messaging_group_agents')").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).not.toContain('trigger_rules');
    expect(cols).not.toContain('response_scope');
    expect(cols).toEqual(
      expect.arrayContaining(['engage_mode', 'engage_pattern', 'sender_scope', 'ignored_message_policy']),
    );
  });
});

describe('agent-destinations migration — backfill from existing wirings', () => {
  function seedAndMigrate(groups: Array<{ id: string; name: string | null; channel: string }>) {
    const db = initTestDb();
    runMigrations(db, upTo('agent-destinations'));

    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES ('ag-1', 'Agent', 'agent', NULL, ?)`,
    ).run(now());

    for (const [i, group] of groups.entries()) {
      db.prepare(
        `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
      ).run(group.id, group.channel, `platform-${i}`, group.name, now());
      db.prepare(
        `INSERT INTO messaging_group_agents
           (id, messaging_group_id, agent_group_id, priority, session_mode, created_at)
         VALUES (?, ?, 'ag-1', 0, 'shared', ?)`,
      ).run(`w-${i}`, group.id, now());
    }

    runMigrations(db);

    return db
      .prepare('SELECT local_name, target_type, target_id FROM agent_destinations ORDER BY local_name')
      .all() as Array<{ local_name: string; target_type: string; target_id: string }>;
  }

  it('normalizes a messaging group name into a slug local name', () => {
    const rows = seedAndMigrate([{ id: 'mg-1', name: 'My Team Chat!', channel: 'telegram' }]);

    expect(rows).toEqual([{ local_name: 'my-team-chat', target_type: 'channel', target_id: 'mg-1' }]);
  });

  it('suffixes colliding names within one agent namespace instead of losing a wiring', () => {
    // Two differently-identified groups that normalize to the same slug must
    // both survive — a lost row here is a silently unreachable destination.
    const rows = seedAndMigrate([
      { id: 'mg-1', name: 'Team Chat', channel: 'telegram' },
      { id: 'mg-2', name: 'team chat', channel: 'telegram' },
      { id: 'mg-3', name: 'TEAM  CHAT', channel: 'telegram' },
    ]);

    expect(rows.map((r) => r.local_name)).toEqual(['team-chat', 'team-chat-2', 'team-chat-3']);
    expect(new Set(rows.map((r) => r.target_id)).size).toBe(3);
  });

  it('falls back to a channel-derived name when the group has no name', () => {
    const rows = seedAndMigrate([{ id: 'mg-abcdefgh12', name: null, channel: 'slack' }]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.local_name).toBe('slack-mg-abcde');
  });

  it('falls back to "unnamed" when a name normalizes to nothing', () => {
    const rows = seedAndMigrate([{ id: 'mg-1', name: '!!!', channel: 'telegram' }]);

    expect(rows).toEqual([{ local_name: 'unnamed', target_type: 'channel', target_id: 'mg-1' }]);
  });
});

describe('pending-approvals-title-options migration — retroactive column add', () => {
  it('is a no-op on a fresh install where 003 already created the columns', () => {
    const db = initTestDb();
    runMigrations(db);

    const cols = (db.prepare("PRAGMA table_info('pending_approvals')").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toEqual(expect.arrayContaining(['title', 'options_json']));
  });

  it('adds the columns to an install whose pending_approvals predates them', () => {
    const db = initTestDb();
    runMigrations(db, upTo('pending-approvals-title-options'));

    // Simulate the old 003 definition by dropping the two columns back off.
    db.exec('ALTER TABLE pending_approvals DROP COLUMN title');
    db.exec('ALTER TABLE pending_approvals DROP COLUMN options_json');

    runMigrations(db);

    const cols = (db.prepare("PRAGMA table_info('pending_approvals')").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toEqual(expect.arrayContaining(['title', 'options_json']));
  });
});

describe('channel-registration migration — idempotent denied_at guard', () => {
  it('does not fail when denied_at was already added by another path', () => {
    const db = initTestDb();
    runMigrations(db, upTo('channel-registration'));

    // Pre-add the column the migration is about to add.
    db.exec('ALTER TABLE messaging_groups ADD COLUMN denied_at TEXT');

    expect(() => runMigrations(db)).not.toThrow();

    const cols = (db.prepare("PRAGMA table_info('messaging_groups')").all() as Array<{ name: string }>).filter(
      (c) => c.name === 'denied_at',
    );
    expect(cols).toHaveLength(1);
  });
});
