import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  root: `/tmp/nanoclaw-memory-migration-${process.pid}`,
  control: {
    agent_group_id: 'group-a',
    mode: 'disabled',
    migration_state: 'none',
    writer_session_id: null,
    maintenance_fence_owner: null,
    maintenance_fence_token: null as string | null,
    maintenance_fenced_at: null,
    version: 1,
    last_transition_at: '2026-07-25T00:00:00.000Z',
    updated_at: '2026-07-25T00:00:00.000Z',
  },
}));

vi.mock('./config.js', () => ({
  DATA_DIR: `${fixture.root}/data`,
  GROUPS_DIR: `${fixture.root}/groups`,
}));
vi.mock('./container-runner.js', () => ({
  drainContainerWakes: vi.fn(),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
}));
vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(() => ({
    id: 'group-a',
    name: 'Group A',
    folder: 'group-a',
    agent_provider: 'claude',
    created_at: '2026-07-25T00:00:00.000Z',
  })),
}));
vi.mock('./db/messaging-groups.js', () => ({ getMessagingGroupsByAgentGroup: vi.fn(() => []) }));
vi.mock('./db/sessions.js', () => ({ getSessionsByAgentGroup: vi.fn(() => []) }));
vi.mock('./modules/scheduling/db.js', () => ({
  listLiveTasks: vi.fn(() => []),
  pauseTask: vi.fn(),
  resumeTask: vi.fn(),
}));
vi.mock('./session-manager.js', () => ({ openInboundDb: vi.fn() }));
vi.mock('./memory-operator.js', () => ({ runMemoryValidatorContainer: vi.fn(async () => ({ ok: true })) }));
vi.mock('./db/agent-group-memory-control.js', () => ({
  acquireAgentGroupMemoryFence: vi.fn((_id: string, _owner: string, token: string) => {
    if (fixture.control.maintenance_fence_token) return false;
    fixture.control.maintenance_fence_token = token;
    return true;
  }),
  getAgentGroupMemoryControl: vi.fn(() => ({ ...fixture.control })),
  releaseAgentGroupMemoryFence: vi.fn(() => {
    fixture.control.maintenance_fence_token = null;
    return true;
  }),
  restoreAgentGroupMemoryControl: vi.fn(),
  transitionAgentGroupMemoryControl: vi.fn(
    (
      _id: string,
      _version: number,
      input: { mode: string; migrationState: string; writerSessionId: string | null },
    ) => {
      Object.assign(fixture.control, {
        mode: input.mode,
        migration_state: input.migrationState,
        writer_session_id: input.writerSessionId,
        version: fixture.control.version + 1,
      });
      return { ...fixture.control };
    },
  ),
}));

import {
  prepareMemoryMigration,
  readMemoryMigrationLedger,
  recordMemoryMigrationClassification,
  rollbackMemoryMigration,
} from './memory-migration.js';

function workspace(): string {
  return path.join(fixture.root, 'groups', 'group-a');
}

beforeEach(() => {
  fs.rmSync(fixture.root, { recursive: true, force: true });
  fs.mkdirSync(workspace(), { recursive: true });
  Object.assign(fixture.control, {
    mode: 'disabled',
    migration_state: 'none',
    writer_session_id: null,
    maintenance_fence_token: null,
    version: 1,
  });
});

describe('memory migration staging', () => {
  it('stages regular files, quarantines symlink objects, resumes idempotently, and reverses without reading targets', async () => {
    fs.writeFileSync(path.join(workspace(), 'CLAUDE.local.md'), 'untrusted private body');
    fs.symlinkSync('/does/not/exist', path.join(workspace(), 'legacy-link'));

    const first = await prepareMemoryMigration('group-a', ['CLAUDE.local.md', 'legacy-link']);
    expect(first.stage).toBe('files-staged');
    expect(first.staged_paths.map((entry) => entry.kind)).toEqual(['regular', 'symlink']);
    expect(fs.lstatSync(path.join(workspace(), first.staged_paths[1].staged)).isSymbolicLink()).toBe(true);

    // Simulate interruption after rename but before the corresponding ledger
    // write. Resume reconstructs the deterministic move record.
    const ledgerFile = path.join(fixture.root, 'data', 'memory-migrations', 'group-a', 'ledger.json');
    const interrupted = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) as typeof first;
    interrupted.stage = 'staging';
    interrupted.staged_paths = [];
    fs.writeFileSync(ledgerFile, JSON.stringify(interrupted));
    const rerun = await prepareMemoryMigration('group-a', ['CLAUDE.local.md', 'legacy-link']);
    expect(rerun.staged_paths).toHaveLength(2);

    const rolledBack = await rollbackMemoryMigration('group-a', first.workflow_id);
    expect(rolledBack.stage).toBe('rolled-back');
    expect(fs.readlinkSync(path.join(workspace(), 'legacy-link'))).toBe('/does/not/exist');
    expect(fs.existsSync(path.join(workspace(), 'CLAUDE.local.md'))).toBe(true);
  });

  it('stops on non-regular nodes and refuses a staging collision on resume', async () => {
    fs.mkdirSync(path.join(workspace(), 'legacy-node'));
    await expect(prepareMemoryMigration('group-a', ['legacy-node'])).rejects.toThrow('special or directory');
    const ledger = readMemoryMigrationLedger('group-a')!;
    const collision = path.join(workspace(), '.nanoclaw-memory-migration', ledger.workflow_id, 'staged', 'legacy-node');
    fs.rmSync(path.join(workspace(), 'legacy-node'), { recursive: true });
    fs.writeFileSync(path.join(workspace(), 'legacy-node'), 'source');
    fs.mkdirSync(path.dirname(collision), { recursive: true });
    fs.writeFileSync(collision, 'existing');
    await expect(prepareMemoryMigration('group-a', ['legacy-node'])).rejects.toThrow('Staging collision');
  });

  it('requires hashed standing-instruction and private-memory destinations for every staged source', async () => {
    fs.writeFileSync(path.join(workspace(), 'CLAUDE.local.md'), 'legacy mixed body');
    const ledger = await prepareMemoryMigration('group-a', ['CLAUDE.local.md']);
    fs.writeFileSync(path.join(workspace(), 'CLAUDE.local.md'), 'standing instructions only');
    fs.mkdirSync(path.join(workspace(), 'memory'));
    fs.writeFileSync(path.join(workspace(), 'memory', 'index.md'), 'private facts');
    const hash = (relative: string) =>
      createHash('sha256')
        .update(fs.readFileSync(path.join(workspace(), relative)))
        .digest('hex');
    const reportRelative = `.memory-classification-${ledger.workflow_id}.json`;
    const reportPath = path.join(workspace(), reportRelative);

    fs.writeFileSync(
      reportPath,
      JSON.stringify({
        workflow_id: ledger.workflow_id,
        entries: [
          {
            source: 'CLAUDE.local.md',
            classification: 'standing-instruction',
            destination: 'CLAUDE.local.md',
            destination_sha256: hash('CLAUDE.local.md'),
          },
          {
            source: 'CLAUDE.local.md',
            classification: 'private-memory',
            destination: 'memory/index.md',
            destination_sha256: hash('memory/index.md'),
          },
        ],
      }),
    );
    expect(recordMemoryMigrationClassification('group-a', reportRelative).stage).toBe('classified');

    const recorded = readMemoryMigrationLedger('group-a')!;
    recorded.stage = 'files-staged';
    fs.writeFileSync(
      path.join(fixture.root, 'data', 'memory-migrations', 'group-a', 'ledger.json'),
      JSON.stringify(recorded),
    );
    fs.writeFileSync(reportPath, JSON.stringify({ workflow_id: ledger.workflow_id, entries: [] }));
    expect(() => recordMemoryMigrationClassification('group-a', reportRelative)).toThrow(
      'Every staged source must be classified',
    );
  });
});
