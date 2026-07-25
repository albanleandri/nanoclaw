import path from 'node:path';

import { DATA_DIR } from '../src/config.js';
import { closeDb, initDb } from '../src/db/connection.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { getAgentGroupMemoryControl } from '../src/db/agent-group-memory-control.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { createSession, getSessionsByAgentGroup } from '../src/db/sessions.js';
import { initSessionFolder } from '../src/session-manager.js';

const readerThreadId = 'synthetic-memory-reader';
const db = initDb(path.join(DATA_DIR, 'v2.db'));
try {
  runMigrations(db);
  const group = getAgentGroupByFolder('memory-canary');
  if (!group || group.name !== 'Memory Canary') throw new Error('Synthetic Memory Canary group was not found');

  const control = getAgentGroupMemoryControl(group.id);
  if (!control || control.mode !== 'active' || control.migration_state !== 'migrated') {
    throw new Error('Memory Canary must be active/migrated before adding its reader session');
  }

  let sessions = getSessionsByAgentGroup(group.id);
  let reader = sessions.find((session) => session.thread_id === readerThreadId);
  if (!reader) {
    const now = new Date().toISOString();
    reader = {
      id: `sess-memory-canary-reader-${Date.now()}`,
      agent_group_id: group.id,
      messaging_group_id: null,
      thread_id: readerThreadId,
      agent_provider: null,
      provider_profile_id: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now,
    };
    createSession(reader);
    initSessionFolder(group.id, reader.id);
    sessions = getSessionsByAgentGroup(group.id);
  }
  if (reader.id === control.writer_session_id) throw new Error('Synthetic reader unexpectedly owns memory writes');
  if (sessions.length !== 2) throw new Error(`Expected exactly two canary sessions, found ${sessions.length}`);

  process.stdout.write(
    `${JSON.stringify({
      agent_group_id: group.id,
      writer_session_id: control.writer_session_id,
      reader_session_id: reader.id,
      reader_thread_id: reader.thread_id,
      expected_memory_access: 'read-only',
    })}\n`,
  );
} finally {
  closeDb();
}
