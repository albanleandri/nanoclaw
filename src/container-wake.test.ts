import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from './db/index.js';
import { wakeContainerWithResult } from './container-runner.js';
import type { Session } from './types.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(closeDb);

describe('wakeContainerWithResult', () => {
  it('returns a typed startup failure instead of reporting success for a missing group', async () => {
    const session: Session = {
      id: 'orphan-session',
      agent_group_id: 'missing-agent-group',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-01-01',
    };

    await expect(wakeContainerWithResult(session)).resolves.toEqual({
      status: 'failed',
      error: 'Agent group not found: missing-agent-group',
    });
  });
});
