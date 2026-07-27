/**
 * Skill provenance is the approval gate on code that gets mounted into every
 * agent session, and the whole resource was uncovered.
 *
 * The two things worth pinning: the global-CLI-scope requirement on every
 * provenance mutation, and the draft-name validation on `promote-draft` —
 * which builds a filesystem path from an operator-supplied name and would copy
 * an arbitrary directory into container/skills/ if the pattern check regressed.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// NOTE: the DATA_DIR literal is inlined rather than referencing TEST_DIR —
// vi.mock factories are hoisted above top-level bindings.
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-skills' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-skills';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { listSkillInstallations } from '../../db/skill-provenance.js';
import type { CallerContext } from '../frame.js';
import { dispatch } from '../dispatch.js';
import './skills.js';

const GROUP = 'ag-skills';
const SESSION = 'sess-skills-1';
const HOST: CallerContext = { caller: 'host' };

function now(): string {
  return new Date().toISOString();
}

function agentCtx(): CallerContext {
  return { caller: 'agent', sessionId: SESSION, agentGroupId: GROUP, messagingGroupId: 'mg-1' };
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'skill-drafts'), { recursive: true });

  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: GROUP, name: GROUP, folder: GROUP, agent_provider: null, created_at: now() });
  ensureContainerConfig(GROUP);
  createSession({
    id: SESSION,
    agent_group_id: GROUP,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('skills — CLI scope gating', () => {
  it('is unreachable from a group-scoped agent', async () => {
    updateContainerConfigScalars(GROUP, { cli_scope: 'group' });

    const resp = await dispatch({ id: 'k1', command: 'skills-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('forbidden');
  });

  it('is unreachable when CLI access is disabled', async () => {
    updateContainerConfigScalars(GROUP, { cli_scope: 'disabled' });

    const resp = await dispatch({ id: 'k2', command: 'skills-installations', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/CLI access is disabled/i);
  });

  it('lists persisted installations for a host caller', async () => {
    const resp = await dispatch({ id: 'k3', command: 'skills-installations', args: {} }, HOST);

    expect(resp.ok).toBe(true);
    if (resp.ok) expect(Array.isArray(resp.data)).toBe(true);
  });
});

describe('skills — approval gating on provenance mutations', () => {
  it.each(['skills-approve', 'skills-disable', 'skills-quarantine', 'skills-promote-draft'])(
    '%s requires admin approval from an agent caller and writes nothing',
    async (command) => {
      updateContainerConfigScalars(GROUP, { cli_scope: 'global' });

      const resp = await dispatch({ id: `k-${command}`, command, args: { name: 'anything' } }, agentCtx());

      expect(resp.ok).toBe(false);
      if (!resp.ok) expect(resp.error.code).toBe('approval-pending');
      expect(listSkillInstallations()).toEqual([]);
    },
  );
});

describe('skills promote-draft — draft name validation', () => {
  it.each([
    ['path traversal', '../../etc'],
    ['absolute path', '/etc/passwd'],
    ['nested path', 'foo/bar'],
    ['leading dash', '-evil'],
    ['uppercase', 'NotAllowed'],
    ['empty', ''],
  ])('rejects %s', async (_label, name) => {
    const resp = await dispatch({ id: 'k4', command: 'skills-promote-draft', args: { name } }, HOST);

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/Invalid draft skill name/i);
  });

  it('rejects a well-formed name that has no draft on disk', async () => {
    const resp = await dispatch({ id: 'k5', command: 'skills-promote-draft', args: { name: 'no-such-draft' } }, HOST);

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/Skill draft not found/i);
  });

  it('refuses to promote a draft with no valid manifest and leaves nothing behind', async () => {
    const name = 'broken-draft';
    const draft = path.join(TEST_DIR, 'skill-drafts', name);
    fs.mkdirSync(draft, { recursive: true });
    fs.writeFileSync(path.join(draft, 'SKILL.md'), '# no manifest\n');

    const target = path.join(process.cwd(), 'container', 'skills', name);
    try {
      const resp = await dispatch({ id: 'k6', command: 'skills-promote-draft', args: { name } }, HOST);

      expect(resp.ok).toBe(false);
      if (!resp.ok) expect(resp.error.message).toMatch(/Promoted skill is invalid/i);
      // The rollback must remove the partially-copied directory.
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
});
