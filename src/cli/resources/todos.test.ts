import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: '/tmp/nanoclaw-test-shared-todos' }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: path.join(TEST_ROOT, 'data'),
    GROUPS_DIR: path.join(TEST_ROOT, 'groups'),
  };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import './todos.js';

const AGENTS = ['ag-claude', 'ag-codex', 'ag-lumo'] as const;

function agentContext(agentGroupId: string): CallerContext {
  return {
    caller: 'agent',
    sessionId: `session-${agentGroupId}`,
    agentGroupId,
    messagingGroupId: `messaging-${agentGroupId}`,
  };
}

describe('shared Todo CLI provider parity', () => {
  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    const todoDir = path.join(TEST_ROOT, 'groups', 'shared', 'knowledge');
    fs.mkdirSync(todoDir, { recursive: true });
    fs.writeFileSync(path.join(todoDir, 'TODO.md'), '# Todo List\n\n## Active\n\n- [ ] Existing item\n\n## Done\n');

    const db = initTestDb();
    runMigrations(db);
    for (const id of [...AGENTS, 'ag-ungranted']) {
      createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
      ensureContainerConfig(id);
    }
    for (const id of AGENTS) updateContainerConfigJson(id, 'shared_resources', ['knowledge']);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('lets Claude, Codex, and Lumo observe each other through one host-managed list', async () => {
    const added = await dispatch(
      { id: 'add', command: 'todos-add', args: { text: 'Shared item', due: '2026-10-01' } },
      agentContext('ag-claude'),
    );
    expect(added.ok).toBe(true);

    const updated = await dispatch(
      { id: 'update', command: 'todos-update', args: { match: 'shared', text: 'Renamed by Lumo' } },
      agentContext('ag-lumo'),
    );
    expect(updated.ok).toBe(true);

    const completed = await dispatch(
      { id: 'complete', command: 'todos-complete', args: { match: 'renamed' } },
      agentContext('ag-codex'),
    );
    expect(completed.ok).toBe(true);

    for (const id of AGENTS) {
      const listed = await dispatch({ id: `list-${id}`, command: 'todos-list', args: {} }, agentContext(id));
      expect(listed.ok).toBe(true);
      expect(listed.ok ? listed.data : undefined).toEqual([
        { text: 'Existing item', completed: false, due: null },
        { text: 'Renamed by Lumo', completed: true, due: '2026-10-01' },
      ]);
    }
  });

  it('rejects an agent without the shared knowledge grant', async () => {
    const response = await dispatch({ id: 'ungranted', command: 'todos-list', args: {} }, agentContext('ag-ungranted'));
    expect(response).toMatchObject({ ok: false, error: { code: 'handler-error' } });
    expect(response.ok ? '' : response.error.message).toMatch(/not granted the shared knowledge resource/);
  });
});
