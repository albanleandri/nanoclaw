import path from 'node:path';

import { DATA_DIR } from '../src/config.js';
import { initDb, closeDb } from '../src/db/connection.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { getAgentGroupMemoryControl, transitionAgentGroupMemoryControl } from '../src/db/agent-group-memory-control.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { updateContainerConfigJson, updateContainerConfigScalars } from '../src/db/container-configs.js';
import { getSessionsByAgentGroup } from '../src/db/sessions.js';
import { initGroupFilesystem } from '../src/group-init.js';
import { resolveSession } from '../src/session-manager.js';

const folder = 'memory-canary';
const now = new Date().toISOString();
const db = initDb(path.join(DATA_DIR, 'v2.db'));

try {
  runMigrations(db);
  let group = getAgentGroupByFolder(folder);
  if (!group) {
    group = {
      id: `ag-memory-canary-${Date.now()}`,
      name: 'Memory Canary',
      folder,
      agent_provider: null,
      created_at: now,
    };
    createAgentGroup(group);
  }
  initGroupFilesystem(group, {
    instructions:
      'Synthetic provider-neutral memory canary. It has no messaging routes, shared resources, schedules, or production data.',
  });
  updateContainerConfigScalars(group.id, { provider: 'claude', cli_scope: 'disabled' });
  updateContainerConfigJson(group.id, 'shared_resources', []);
  const existingControl = getAgentGroupMemoryControl(group.id)!;
  const sessions = getSessionsByAgentGroup(group.id);
  const session =
    sessions.find((candidate) => candidate.id === existingControl.writer_session_id) ??
    sessions[0] ??
    resolveSession(group.id, null, null, 'agent-shared').session;
  const control = getAgentGroupMemoryControl(group.id)!;
  if (control.mode === 'disabled') {
    transitionAgentGroupMemoryControl(group.id, control.version, {
      mode: 'shadow',
      migrationState: 'staging',
      writerSessionId: session.id,
    });
  } else if (control.writer_session_id !== session.id) {
    throw new Error('Existing memory-canary writer does not match its control row');
  }
  const current = getAgentGroupMemoryControl(group.id)!;
  process.stdout.write(
    `${JSON.stringify({
      agent_group_id: group.id,
      session_id: session.id,
      folder,
      mode: current.mode,
      migration_state: current.migration_state,
      shared_resources: [],
      messaging_routes: 0,
    })}\n`,
  );
} finally {
  closeDb();
}
