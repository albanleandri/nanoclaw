import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import type { AgentGroup } from '../types.js';
import { composeGroupAgentsMd } from './codex-agents-md.js';

const group: AgentGroup = {
  id: 'ag-codex-doc-test',
  name: 'Codex Doc Test',
  folder: 'codex-doc-test',
  agent_provider: 'codex',
  created_at: '2026-06-19T00:00:00.000Z',
};

describe('composeGroupAgentsMd shared knowledge instructions', () => {
  let groupDir: string;

  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-agents-md-'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  it('includes the provider-neutral shared knowledge contract for Codex agents', () => {
    composeGroupAgentsMd(group, groupDir);

    const doc = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
    expect(doc).toContain('## Shared knowledge');
    expect(doc).toContain('/workspace/agent/shared/knowledge/MEMORY.md');
    expect(doc).toContain('/workspace/agent/shared/knowledge/knowledge/preferences/communication.md');
    expect(doc).toContain('/workspace/agent/shared/knowledge/knowledge/people/alban.md');
    expect(doc).toContain('Do not duplicate shared user preferences into provider-specific memory files.');
  });
});
