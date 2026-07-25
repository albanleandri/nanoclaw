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
});
