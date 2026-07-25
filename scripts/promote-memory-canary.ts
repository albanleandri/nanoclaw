import path from 'node:path';

import { DATA_DIR } from '../src/config.js';
import { closeDb, initDb } from '../src/db/connection.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { getAgentGroupMemoryControl, transitionAgentGroupMemoryControl } from '../src/db/agent-group-memory-control.js';
import { getContainerConfig } from '../src/db/container-configs.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { getSessionsByAgentGroup } from '../src/db/sessions.js';

const db = initDb(path.join(DATA_DIR, 'v2.db'));
try {
  runMigrations(db);
  const group = getAgentGroupByFolder('memory-canary');
  if (!group || group.name !== 'Memory Canary') throw new Error('Synthetic Memory Canary group was not found');

  const sessions = getSessionsByAgentGroup(group.id);
  const existingControl = getAgentGroupMemoryControl(group.id);
  const writerSessionId = existingControl?.writer_session_id ?? sessions[0]?.id;
  if (!writerSessionId || !sessions.some((session) => session.id === writerSessionId)) {
    throw new Error('Canary writer session was not found');
  }
  const routeCount = (
    db.prepare('SELECT COUNT(*) AS count FROM messaging_group_agents WHERE agent_group_id = ?').get(group.id) as {
      count: number;
    }
  ).count;
  if (routeCount !== 0) throw new Error(`Canary unexpectedly has ${routeCount} messaging route(s)`);

  const config = getContainerConfig(group.id);
  const sharedResources = config ? (JSON.parse(config.shared_resources) as unknown[]) : null;
  if (!sharedResources || sharedResources.length !== 0) {
    throw new Error('Canary unexpectedly has shared resources');
  }

  let control = existingControl;
  if (!control) throw new Error('Canary memory control is missing');
  if (control.mode === 'shadow' && control.migration_state === 'staging') {
    control = transitionAgentGroupMemoryControl(group.id, control.version, {
      mode: 'shadow',
      migrationState: 'validated',
      writerSessionId,
    });
  }
  if (control.mode === 'shadow' && control.migration_state === 'validated') {
    control = transitionAgentGroupMemoryControl(group.id, control.version, {
      mode: 'active',
      migrationState: 'migrated',
      writerSessionId,
    });
  }
  if (
    control.mode !== 'active' ||
    control.migration_state !== 'migrated' ||
    control.writer_session_id !== writerSessionId
  ) {
    throw new Error('Canary is not in the expected active/migrated state');
  }

  process.stdout.write(
    `${JSON.stringify({
      agent_group_id: group.id,
      session_id: writerSessionId,
      mode: control.mode,
      migration_state: control.migration_state,
      version: control.version,
      messaging_routes: routeCount,
      shared_resources: sharedResources,
    })}\n`,
  );
} finally {
  closeDb();
}
