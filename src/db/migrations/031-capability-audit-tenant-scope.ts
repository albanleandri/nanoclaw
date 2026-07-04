import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Scope capability-audit invocation chains to the owning agent group.
 *
 * Migration 026 keyed uniqueness globally as UNIQUE(invocation_id, seq), and
 * the append path validates an invocation's event chain by invocation_id
 * alone. Since invocation_id is chosen by the (container-side) caller while
 * only agent_group_id is stamped from the trusted session, one group could
 * reuse another group's invocation_id and either collide on the unique
 * constraint (blocking the victim's appends) or chain its events onto the
 * victim's audit timeline. Re-key uniqueness on
 * (agent_group_id, invocation_id, seq) so each tenant has its own namespace;
 * the append path is updated in tandem to filter the chain lookup by
 * agent_group_id.
 *
 * event_id was also a GLOBAL primary key, and it is derived from the
 * container-controlled invocation_id (`capability-audit:<invocation_id>:<seq>`),
 * so a reused event_id was a second cross-tenant collision vector (group B
 * pre-inserting group A's event_id would block A on the PK). Re-key event_id
 * per tenant too — UNIQUE(agent_group_id, event_id) on a rowid table — and the
 * append idempotency check is scoped by agent_group_id in tandem.
 *
 * SQLite can't alter a table-level PRIMARY KEY / UNIQUE in place, so rebuild the
 * table (create → copy → drop → rename). No other table references
 * capability_audit_events, so the rebuild is FK-safe.
 */
export const migration031: Migration = {
  version: 31,
  name: 'capability-audit-tenant-scope',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE capability_audit_events_new (
        event_id        TEXT NOT NULL,
        invocation_id   TEXT NOT NULL,
        seq             INTEGER NOT NULL,
        event_type      TEXT NOT NULL CHECK (event_type IN (
          'requested', 'authorized', 'denied', 'started',
          'succeeded', 'failed', 'cancelled'
        )),
        agent_group_id  TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        runtime_id      TEXT,
        capability_id   TEXT NOT NULL,
        capability_version INTEGER NOT NULL,
        adapter         TEXT NOT NULL,
        entrypoint      TEXT NOT NULL,
        args_sha256     TEXT NOT NULL,
        decision        TEXT,
        result_class    TEXT,
        duration_ms     INTEGER,
        usage_json      TEXT,
        created_at      TEXT NOT NULL,
        orchestration_run_id TEXT REFERENCES orchestration_runs(run_id) ON DELETE SET NULL,
        UNIQUE(agent_group_id, event_id),
        UNIQUE(agent_group_id, invocation_id, seq)
      );

      INSERT INTO capability_audit_events_new (
        event_id, invocation_id, seq, event_type, agent_group_id, session_id,
        runtime_id, capability_id, capability_version, adapter, entrypoint,
        args_sha256, decision, result_class, duration_ms, usage_json,
        created_at, orchestration_run_id
      )
      SELECT
        event_id, invocation_id, seq, event_type, agent_group_id, session_id,
        runtime_id, capability_id, capability_version, adapter, entrypoint,
        args_sha256, decision, result_class, duration_ms, usage_json,
        created_at, orchestration_run_id
      FROM capability_audit_events;

      DROP TABLE capability_audit_events;
      ALTER TABLE capability_audit_events_new RENAME TO capability_audit_events;

      CREATE INDEX idx_capability_audit_scope
        ON capability_audit_events(agent_group_id, created_at);
      CREATE INDEX idx_capability_audit_capability
        ON capability_audit_events(capability_id, created_at);
      CREATE INDEX idx_capability_audit_orchestration
        ON capability_audit_events(orchestration_run_id);
    `);
  },
};
