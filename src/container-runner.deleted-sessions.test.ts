// Ported from upstream 94d82996 (#3909): the sweep only visits sessions that
// still have a row, so a container whose session or agent group was deleted
// kept running and writing outbound until the next host restart.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findContainersOfDeletedSessions } from './container-runner.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from './db/index.js';
import { createSession } from './db/sessions.js';

function session(id: string, agentGroupId: string): void {
  createSession({
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
  });
}

beforeEach(() => {
  runMigrations(initTestDb());
  createAgentGroup({ id: 'ag-live', name: 'Live', folder: 'live', agent_provider: null, created_at: '' });
  createAgentGroup({ id: 'ag-gone', name: 'Gone', folder: 'gone', agent_provider: null, created_at: '' });
  session('sess-live', 'ag-live');
  session('sess-group-gone', 'ag-gone');
});

afterEach(() => closeDb());

describe('findContainersOfDeletedSessions', () => {
  it('keeps live sessions and flags deleted sessions and sessions of deleted groups', () => {
    const db = getDb();
    db.pragma('foreign_keys = OFF');
    db.prepare("DELETE FROM agent_groups WHERE id = 'ag-gone'").run();
    db.pragma('foreign_keys = ON');

    expect(findContainersOfDeletedSessions(['sess-live', 'sess-group-gone', 'sess-never-existed'])).toEqual([
      'sess-group-gone',
      'sess-never-existed',
    ]);
  });
});
