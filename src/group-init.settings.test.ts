import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ROOT } = vi.hoisted(() => ({ ROOT: '/tmp/nanoclaw-group-init-settings' }));

vi.mock('./config.js', () => ({
  DATA_DIR: `${ROOT}/data`,
  GROUPS_DIR: `${ROOT}/groups`,
}));
vi.mock('./db/container-configs.js', () => ({ ensureContainerConfig: vi.fn() }));
vi.mock('./log.js', () => ({ log: { info: vi.fn() } }));

import { initGroupFilesystem } from './group-init.js';
import type { AgentGroup } from './types.js';

const group = { id: 'ag-new', name: 'New Agent', folder: 'new-agent' } as AgentGroup;
const settingsPath = path.join(ROOT, 'data', 'v2-sessions', group.id, '.claude-shared', 'settings.json');

beforeEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('new-group Claude settings', () => {
  it('uses the lean harness defaults', () => {
    initGroupFilesystem(group);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      env: Record<string, string>;
      disableWorkflows: boolean;
    };

    expect(settings.disableWorkflows).toBe(true);
    expect(settings.env).not.toHaveProperty('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS');
    expect(settings.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('1');
  });

  it('does not rewrite existing operator settings', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } }));

    initGroupFilesystem(group);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { env: Record<string, string> };
    expect(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });
});
