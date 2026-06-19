import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-shared-resources' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-shared-resources';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { ensureContainerConfig, getContainerConfig } from '../../db/container-configs.js';
import { dispatch } from '../dispatch.js';
import './groups.js';

function now(): string {
  return new Date().toISOString();
}

describe('groups CLI config set-shared-resources', () => {
  const GID = 'ag-shared-1';

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({ id: GID, name: 'Shared Test', folder: 'shared-test', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('defaults to an empty list', () => {
    expect(JSON.parse(getContainerConfig(GID)!.shared_resources)).toEqual([]);
  });

  it('sets an explicit normalized resource list', async () => {
    const resp = await dispatch(
      {
        id: 'req-1',
        command: 'groups-config-set-shared-resources',
        args: { id: GID, 'shared-resources': '["knowledge","docs","knowledge"]' },
      },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    expect(JSON.parse(getContainerConfig(GID)!.shared_resources)).toEqual(['knowledge', 'docs']);
  });

  it('treats none as clearing the list', async () => {
    await dispatch(
      {
        id: 'req-2',
        command: 'groups-config-set-shared-resources',
        args: { id: GID, 'shared-resources': '["knowledge"]' },
      },
      { caller: 'host' },
    );
    const resp = await dispatch(
      { id: 'req-3', command: 'groups-config-set-shared-resources', args: { id: GID, 'shared-resources': 'none' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);
    expect(JSON.parse(getContainerConfig(GID)!.shared_resources)).toEqual([]);
  });

  it('rejects a non-array value', async () => {
    const resp = await dispatch(
      {
        id: 'req-4',
        command: 'groups-config-set-shared-resources',
        args: { id: GID, 'shared-resources': '{"not":"array"}' },
      },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(false);
  });
});
