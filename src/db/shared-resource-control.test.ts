import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildSharedResourceMounts } from '../container-runner.js';
import {
  closeDb,
  createAgentGroup,
  ensureSharedResourceControl,
  getSharedResourceControl,
  initTestDb,
  runMigrations,
  transferSharedResourceOwner,
  transitionSharedResourceControl,
} from './index.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  for (const id of ['owner', 'reader']) {
    createAgentGroup({
      id,
      name: id,
      folder: id,
      agent_provider: null,
      created_at: '2026-07-25T00:00:00.000Z',
    });
  }
});

afterEach(closeDb);

describe('shared resource ownership', () => {
  it('progresses only through explicit reconciliation and requires approval for an owner', () => {
    ensureSharedResourceControl('knowledge');
    const pilot = getSharedResourceControl('knowledge')!;
    const reconciling = transitionSharedResourceControl('knowledge', pilot.version, 'pilot', {
      state: 'reconciling',
      ownerAgentGroupId: 'owner',
    });
    const validated = transitionSharedResourceControl('knowledge', reconciling.version, 'reconciling', {
      state: 'validated',
      ownerAgentGroupId: 'owner',
      classificationReportPath: 'report.json',
      classificationReportSha256: 'abc',
      validationReportJson: '{"ok":true}',
    });
    expect(() =>
      transitionSharedResourceControl('knowledge', validated.version, 'validated', {
        state: 'reconciled',
        ownerAgentGroupId: 'owner',
      }),
    ).toThrow('explicit approval');
    expect(
      transitionSharedResourceControl('knowledge', validated.version, 'validated', {
        state: 'reconciled',
        ownerAgentGroupId: 'owner',
        approvedAt: '2026-07-25T01:00:00.000Z',
      }),
    ).toMatchObject({ reconciliation_state: 'reconciled', owner_agent_group_id: 'owner' });
  });

  it('mounts only explicit grants, with write access limited to the reconciled owner', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-owner-mounts-'));
    try {
      fs.mkdirSync(path.join(root, 'groups', 'shared', 'knowledge'), { recursive: true });
      fs.mkdirSync(path.join(root, 'groups', 'shared', 'ungranted'), { recursive: true });
      const config = {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all' as const,
        sharedResources: ['knowledge'],
      };
      expect(buildSharedResourceMounts('owner', config, root)).toEqual([
        {
          hostPath: path.join(root, 'groups', 'shared', 'knowledge'),
          containerPath: '/app/shared/knowledge',
          readonly: true,
        },
      ]);
      ensureSharedResourceControl('knowledge');
      const first = transitionSharedResourceControl('knowledge', 1, 'pilot', {
        state: 'reconciling',
        ownerAgentGroupId: 'owner',
      });
      const second = transitionSharedResourceControl('knowledge', first.version, 'reconciling', {
        state: 'validated',
        ownerAgentGroupId: 'owner',
      });
      transitionSharedResourceControl('knowledge', second.version, 'validated', {
        state: 'reconciled',
        ownerAgentGroupId: 'owner',
        approvedAt: '2026-07-25T01:00:00.000Z',
      });
      expect(buildSharedResourceMounts('owner', config, root)[0].readonly).toBe(false);
      expect(buildSharedResourceMounts('reader', config, root)[0].readonly).toBe(true);
      expect(buildSharedResourceMounts('owner', { ...config, sharedResources: [] }, root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('transfers reconciled ownership with owner and version compare-and-swap protection', () => {
    ensureSharedResourceControl('trading-data');
    const reconciling = transitionSharedResourceControl('trading-data', 1, 'pilot', {
      state: 'reconciling',
      ownerAgentGroupId: 'owner',
    });
    const validated = transitionSharedResourceControl('trading-data', reconciling.version, 'reconciling', {
      state: 'validated',
      ownerAgentGroupId: 'owner',
    });
    const reconciled = transitionSharedResourceControl('trading-data', validated.version, 'validated', {
      state: 'reconciled',
      ownerAgentGroupId: 'owner',
      approvedAt: '2026-07-25T01:00:00.000Z',
    });

    const transferred = transferSharedResourceOwner(
      'trading-data',
      reconciled.version,
      'owner',
      'reader',
      '2026-07-25T02:00:00.000Z',
    );
    expect(transferred).toMatchObject({
      owner_agent_group_id: 'reader',
      reconciliation_state: 'reconciled',
      version: reconciled.version + 1,
    });
    expect(() => transferSharedResourceOwner('trading-data', reconciled.version, 'owner', 'reader')).toThrow(
      'owner transfer conflict',
    );
  });
});
