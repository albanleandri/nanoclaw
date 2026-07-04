import type { Migration } from './index.js';

export const migration032: Migration = {
  version: 32,
  name: 'user-role-global-uniqueness',
  up(db) {
    // SQLite treats NULL values as distinct in a composite primary key, so
    // (user_id, role, NULL) could be inserted repeatedly. Preserve the oldest
    // row from each legacy duplicate set before adding the partial index.
    db.prepare(
      `DELETE FROM user_roles
       WHERE agent_group_id IS NULL
         AND rowid NOT IN (
           SELECT MIN(rowid)
           FROM user_roles
           WHERE agent_group_id IS NULL
           GROUP BY user_id, role
         )`,
    ).run();
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_global_unique
      ON user_roles(user_id, role)
      WHERE agent_group_id IS NULL
    `);
  },
};
