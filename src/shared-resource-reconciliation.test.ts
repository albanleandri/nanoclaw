import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT, runningSessions } = vi.hoisted(() => ({
  TEST_ROOT: '/tmp/nanoclaw-shared-owner-transfer',
  runningSessions: new Set<string>(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: `${TEST_ROOT}/data`,
    GROUPS_DIR: `${TEST_ROOT}/groups`,
  };
});

vi.mock('./container-runner.js', async () => {
  const actual = await vi.importActual<typeof import('./container-runner.js')>('./container-runner.js');
  return {
    ...actual,
    isContainerRunning: (sessionId: string) => runningSessions.has(sessionId),
  };
});

import { buildSharedResourceMounts } from './container-runner.js';
import {
  closeDb,
  createAgentGroup,
  ensureSharedResourceControl,
  getDb,
  getSharedResourceControl,
  initTestDb,
  runMigrations,
  transitionSharedResourceControl,
} from './db/index.js';
import { ensureContainerConfig, updateContainerConfigJson } from './db/container-configs.js';
import { transferSharedResourceReconciliationOwner } from './shared-resource-reconciliation.js';

const OWNER = 'pinova-claude';
const PEER = 'pinova-codex';
const RESOURCE = 'trading-data';
const REPORT_RELATIVE = 'shared-resource-reconciliation/trading-data/classification.json';

function prepareReconciledResource(): void {
  const resourceDir = path.join(TEST_ROOT, 'groups', 'shared', RESOURCE);
  fs.mkdirSync(resourceDir, { recursive: true });
  fs.writeFileSync(path.join(resourceDir, 'investments.db'), 'sqlite-data');
  const reportPath = path.join(TEST_ROOT, 'data', REPORT_RELATIVE);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, '{"resource_name":"trading-data","pilot_markers_removed":true,"entries":[]}');
  const reportHash = createHash('sha256').update(fs.readFileSync(reportPath)).digest('hex');

  ensureSharedResourceControl(RESOURCE);
  const reconciling = transitionSharedResourceControl(RESOURCE, 1, 'pilot', {
    state: 'reconciling',
    ownerAgentGroupId: OWNER,
  });
  const validated = transitionSharedResourceControl(RESOURCE, reconciling.version, 'reconciling', {
    state: 'validated',
    ownerAgentGroupId: OWNER,
    classificationReportPath: REPORT_RELATIVE,
    classificationReportSha256: reportHash,
    validationReportJson: '{"ok":true}',
  });
  transitionSharedResourceControl(RESOURCE, validated.version, 'validated', {
    state: 'reconciled',
    ownerAgentGroupId: OWNER,
    approvedAt: '2026-07-27T00:00:00.000Z',
  });
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'groups'), { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  for (const id of [OWNER, PEER, 'ungranted']) {
    createAgentGroup({
      id,
      name: id,
      folder: id,
      agent_provider: null,
      created_at: '2026-07-27T00:00:00.000Z',
    });
    ensureContainerConfig(id);
  }
  updateContainerConfigJson(OWNER, 'shared_resources', [RESOURCE]);
  updateContainerConfigJson(PEER, 'shared_resources', [RESOURCE]);
  getDb()
    .prepare(
      `INSERT INTO sessions (id, agent_group_id, status, container_status, created_at)
       VALUES (?, ?, 'active', 'stopped', ?)`,
    )
    .run('sess-claude', OWNER, '2026-07-27T00:00:00.000Z');
  getDb()
    .prepare(
      `INSERT INTO sessions (id, agent_group_id, status, container_status, created_at)
       VALUES (?, ?, 'active', 'stopped', ?)`,
    )
    .run('sess-codex', PEER, '2026-07-27T00:00:00.000Z');
  runningSessions.clear();
  prepareReconciledResource();
});

afterEach(() => {
  closeDb();
  runningSessions.clear();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('shared-resource owner transfer policy', () => {
  it('transfers between granted stopped groups and reverses effective mount access', () => {
    const before = getSharedResourceControl(RESOURCE)!;
    const transferred = transferSharedResourceReconciliationOwner(RESOURCE, PEER, OWNER, before.version, RESOURCE);
    expect(transferred).toMatchObject({ owner_agent_group_id: PEER, version: before.version + 1 });

    const config = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all' as const,
      sharedResources: [RESOURCE],
    };
    expect(buildSharedResourceMounts(OWNER, config, TEST_ROOT)[0].readonly).toBe(true);
    expect(buildSharedResourceMounts(PEER, config, TEST_ROOT)[0].readonly).toBe(false);
  });

  it.each([
    ['wrong confirmation', PEER, OWNER, 4, 'wrong'],
    ['wrong current owner', PEER, 'someone-else', 4, RESOURCE],
    ['wrong version', PEER, OWNER, 99, RESOURCE],
    ['same owner', OWNER, OWNER, 4, RESOURCE],
    ['ungranted owner', 'ungranted', OWNER, 4, RESOURCE],
  ])('rejects %s without changing control state', (_label, newOwner, expectedOwner, version, confirm) => {
    const before = getSharedResourceControl(RESOURCE)!;
    expect(() =>
      transferSharedResourceReconciliationOwner(RESOURCE, newOwner, expectedOwner, version, confirm),
    ).toThrow();
    expect(getSharedResourceControl(RESOURCE)).toEqual(before);
  });

  it('rejects transfer while either granted-group container is running', () => {
    runningSessions.add('sess-codex');
    const before = getSharedResourceControl(RESOURCE)!;
    expect(() => transferSharedResourceReconciliationOwner(RESOURCE, PEER, OWNER, before.version, RESOURCE)).toThrow(
      'Stop all granted-group containers',
    );
    expect(getSharedResourceControl(RESOURCE)).toEqual(before);
  });

  it('rejects changed or missing retained classification evidence', () => {
    const reportPath = path.join(TEST_ROOT, 'data', REPORT_RELATIVE);
    const before = getSharedResourceControl(RESOURCE)!;
    fs.writeFileSync(reportPath, '{"changed":true}');
    expect(() => transferSharedResourceReconciliationOwner(RESOURCE, PEER, OWNER, before.version, RESOURCE)).toThrow(
      'Classification report changed',
    );
    expect(getSharedResourceControl(RESOURCE)).toEqual(before);

    fs.rmSync(reportPath);
    expect(() => transferSharedResourceReconciliationOwner(RESOURCE, PEER, OWNER, before.version, RESOURCE)).toThrow();
    expect(getSharedResourceControl(RESOURCE)).toEqual(before);
  });
});
