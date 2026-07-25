import path from 'node:path';

import { DATA_DIR } from '../src/config.js';
import { closeDb, initDb } from '../src/db/connection.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { getSessionsByAgentGroup } from '../src/db/sessions.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { writeSessionMessage } from '../src/session-manager.js';

const targetArgIndex = process.argv.indexOf('--target');
const target = targetArgIndex === -1 ? 'writer' : process.argv[targetArgIndex + 1];
if (target !== 'writer' && target !== 'reader') {
  throw new Error('--target must be writer or reader');
}
const text = process.argv
  .slice(2)
  .filter((_, index, args) => args[index - 1] !== '--target' && args[index] !== '--target')
  .join(' ')
  .trim();
if (!text) {
  throw new Error('Usage: pnpm exec tsx scripts/send-memory-canary-message.ts <message>');
}

const db = initDb(path.join(DATA_DIR, 'v2.db'));
try {
  runMigrations(db);
  const group = getAgentGroupByFolder('memory-canary');
  if (!group) throw new Error('Memory Canary group does not exist');

  const sessions = getSessionsByAgentGroup(group.id);
  const control = db
    .prepare('SELECT writer_session_id FROM agent_group_memory_control WHERE agent_group_id = ?')
    .get(group.id) as { writer_session_id: string | null } | undefined;
  const session =
    target === 'writer'
      ? sessions.find((candidate) => candidate.id === control?.writer_session_id)
      : sessions.find((candidate) => candidate.id !== control?.writer_session_id);
  if (!session) throw new Error(`Memory Canary ${target} session does not exist`);
  const messageId = `memory-canary-${Date.now()}`;
  writeSessionMessage(group.id, session.id, {
    id: messageId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    channelType: 'synthetic-canary',
    content: JSON.stringify({ sender: 'Phase 8 operator', text }),
  });
  process.stdout.write(
    `${JSON.stringify({ agent_group_id: group.id, session_id: session.id, message_id: messageId })}\n`,
  );
} finally {
  closeDb();
}
