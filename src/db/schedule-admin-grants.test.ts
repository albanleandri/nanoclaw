import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from './agent-groups.js';
import { closeDb, initTestDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import {
  getScheduleAdminGrants,
  grantScheduleAdmin,
  isScheduleAdminAuthorized,
  revokeScheduleAdmin,
} from './schedule-admin-grants.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  for (const id of ['admin', 'owner']) {
    createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  }
});

afterEach(() => closeDb());

describe('schedule admin grants', () => {
  it('grants, lists, authorizes, and revokes an arbitrary group pair', () => {
    grantScheduleAdmin('admin', 'owner', 'test');
    expect(getScheduleAdminGrants('admin')).toMatchObject([
      { admin_agent_group_id: 'admin', owner_agent_group_id: 'owner', created_by: 'test' },
    ]);
    expect(isScheduleAdminAuthorized('admin', 'owner')).toBe(true);
    expect(revokeScheduleAdmin('admin', 'owner')).toBe(true);
    expect(isScheduleAdminAuthorized('admin', 'owner')).toBe(false);
  });

  it('rejects redundant self grants', () => {
    expect(() => grantScheduleAdmin('admin', 'admin')).toThrow(/self-grant/);
  });
});
