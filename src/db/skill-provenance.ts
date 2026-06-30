import { randomUUID } from 'crypto';

import type { SkillCatalogEntry } from '../skills/catalog.js';
import { hashSkillDirectory } from '../skills/hash.js';
import { getDb } from './connection.js';

export type SkillInstallationState = 'active' | 'drifted' | 'quarantined' | 'disabled';

export interface SkillInstallation {
  name: string;
  source_kind: string;
  source_id: string;
  manifest_version: string;
  approved_hash: string | null;
  observed_hash: string;
  state: SkillInstallationState;
  approved_by: string | null;
  approved_at: string | null;
  updated_at: string;
}

export function getSkillInstallation(name: string): SkillInstallation | undefined {
  return getDb().prepare('SELECT * FROM skill_installations WHERE name = ?').get(name) as SkillInstallation | undefined;
}

export function listSkillInstallations(): SkillInstallation[] {
  return getDb().prepare('SELECT * FROM skill_installations ORDER BY name').all() as SkillInstallation[];
}

function appendEvent(name: string, eventType: string, hash: string, actor?: string): void {
  getDb()
    .prepare(
      `INSERT INTO skill_provenance_events
       (id, skill_name, event_type, content_hash, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), name, eventType, hash, actor ?? null, new Date().toISOString());
}

export function observeSkill(entry: SkillCatalogEntry): SkillInstallation | undefined {
  if (!entry.manifest || entry.error) return undefined;
  const existing = getSkillInstallation(entry.name);
  const state: SkillInstallationState = !existing
    ? 'quarantined'
    : existing.state === 'disabled'
      ? 'disabled'
      : existing.approved_hash === entry.hash
        ? 'active'
        : 'drifted';
  const now = new Date().toISOString();
  getDb().transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO skill_installations
         (name, source_kind, source_id, manifest_version, approved_hash, observed_hash,
          state, approved_by, approved_at, updated_at)
         VALUES (@name, @sourceKind, @sourceId, @version, NULL, @hash, @state, NULL, NULL, @now)
         ON CONFLICT(name) DO UPDATE SET
           source_kind=excluded.source_kind,
           source_id=excluded.source_id,
           manifest_version=excluded.manifest_version,
           observed_hash=excluded.observed_hash,
           state=excluded.state,
           updated_at=excluded.updated_at`,
      )
      .run({
        name: entry.name,
        sourceKind: entry.manifest!.source.kind,
        sourceId: entry.manifest!.source.id,
        version: entry.manifest!.version,
        hash: entry.hash,
        state,
        now,
      });
    if (!existing || existing.observed_hash !== entry.hash || existing.state !== state) {
      appendEvent(entry.name, state === 'active' ? 'observed' : state, entry.hash);
    }
  })();
  return getSkillInstallation(entry.name);
}

export function approveSkill(entry: SkillCatalogEntry, actor: string): SkillInstallation {
  if (!entry.manifest || entry.error || !entry.hash) throw new Error(`Skill cannot be approved: ${entry.name}`);
  if (hashSkillDirectory(entry.directory) !== entry.hash) {
    throw new Error(`Skill content changed during approval: ${entry.name}`);
  }
  observeSkill(entry);
  const now = new Date().toISOString();
  getDb().transaction(() => {
    getDb()
      .prepare(
        `UPDATE skill_installations SET
          approved_hash=?, observed_hash=?, state='active',
          approved_by=?, approved_at=?, updated_at=?
         WHERE name=?`,
      )
      .run(entry.hash, entry.hash, actor, now, now, entry.name);
    appendEvent(entry.name, 'approved', entry.hash, actor);
  })();
  return getSkillInstallation(entry.name)!;
}

export function setSkillState(name: string, state: 'disabled' | 'quarantined', actor: string): SkillInstallation {
  const current = getSkillInstallation(name);
  if (!current) throw new Error(`Skill installation not found: ${name}`);
  getDb().transaction(() => {
    getDb()
      .prepare('UPDATE skill_installations SET state=?, updated_at=? WHERE name=?')
      .run(state, new Date().toISOString(), name);
    appendEvent(name, state, current.observed_hash, actor);
  })();
  return getSkillInstallation(name)!;
}
