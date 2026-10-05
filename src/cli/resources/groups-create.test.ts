/**
 * Ported from upstream 92a3518b. `ncl groups delete` removes DB rows only, so
 * groups/<folder>/ survives; before this, every create path checked only the
 * DB, and a new group silently adopted the deleted group's memory, skills,
 * and composed instructions under a new identity.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  isContainerWakeInFlight: vi.fn().mockReturnValue(false),
  drainContainerWakes: vi.fn().mockResolvedValue(undefined),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-groups-create/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-groups-create/groups',
  };
});

const ROOT = '/tmp/nanoclaw-test-groups-create';
const GROUPS = `${ROOT}/groups`;

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { groupFolderExistsOnDisk } from '../../group-folder.js';
import { dispatch } from '../dispatch.js';
import './groups.js';

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(GROUPS, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

async function create(folder: string) {
  return dispatch({ id: 'c', command: 'groups-create', args: { name: 'New', folder } }, { caller: 'host' });
}

describe('groups create over a leftover folder', () => {
  it('refuses a folder that exists on disk with no claiming group', async () => {
    fs.mkdirSync(`${GROUPS}/old-agent`);
    fs.writeFileSync(`${GROUPS}/old-agent/CLAUDE.local.md`, 'old memory');

    const res = await create('old-agent');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain('already exists on disk but no agent group claims it');
    expect((getDb().prepare('SELECT COUNT(*) AS c FROM agent_groups').get() as { c: number }).c).toBe(0);
  });

  it('treats a dangling symlink as occupying the name', () => {
    fs.symlinkSync(`${ROOT}/nowhere`, `${GROUPS}/ghost`);
    expect(groupFolderExistsOnDisk('ghost')).toBe(true);
  });

  it('names the real cause when another group owns the folder', async () => {
    createAgentGroup({ id: 'ag-live', name: 'Live', folder: 'live', agent_provider: null, created_at: '' });
    fs.mkdirSync(`${GROUPS}/live`);

    const res = await create('live');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain('already used by another agent group');
  });

  it('refuses a folder name outside the folder grammar', async () => {
    const res = await create('../escape');
    expect(res.ok).toBe(false);
  });

  it('creates a group on a free folder', async () => {
    const res = await create('fresh');
    expect(res.ok).toBe(true);
  });
});

describe('minted folder names skip leftover folders', () => {
  it('createNewAgentGroup moves to the next suffix instead of adopting residue', async () => {
    const { createNewAgentGroup } = await import('../../modules/permissions/channel-approval.js');
    fs.mkdirSync(`${GROUPS}/helper`);

    const group = createNewAgentGroup('helper');
    expect(group.folder).toBe('helper-2');
  });
});
