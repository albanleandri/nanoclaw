import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { buildGroupWorkspaceMounts, resolveProviderName, syncSkillSymlinks } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('syncSkillSymlinks', () => {
  it('replaces stale copied skill directories with managed symlinks for selected skills', () => {
    const previousCwd = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skills-'));
    try {
      const customSkill = path.join(tmp, 'container', 'skills', 'custom', 'stock-market-investing');
      fs.mkdirSync(customSkill, { recursive: true });
      fs.writeFileSync(path.join(customSkill, 'SKILL.md'), '# Stock Market Investing\n');

      const claudeDir = path.join(tmp, 'session', '.claude-shared');
      const staleSkillDir = path.join(claudeDir, 'skills', 'stock-market-investing');
      fs.mkdirSync(staleSkillDir, { recursive: true });
      fs.writeFileSync(path.join(staleSkillDir, 'old.txt'), 'stale');

      process.chdir(tmp);
      syncSkillSymlinks(claudeDir, {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: ['stock-market-investing'],
      });

      const linkPath = path.join(claudeDir, 'skills', 'stock-market-investing');
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(linkPath)).toBe('/app/skills/custom/stock-market-investing');
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('buildGroupWorkspaceMounts', () => {
  it('mounts the group workspace at both current and legacy paths with managed overlays read-only', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-group-mounts-'));
    try {
      fs.writeFileSync(path.join(tmp, 'container.json'), '{}');
      fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# Managed');
      fs.mkdirSync(path.join(tmp, '.claude-fragments'));

      const mounts = buildGroupWorkspaceMounts(tmp);

      expect(mounts).toEqual(
        expect.arrayContaining([
          { hostPath: tmp, containerPath: '/workspace/agent', readonly: false },
          { hostPath: tmp, containerPath: '/workspace/group', readonly: false },
          {
            hostPath: path.join(tmp, 'container.json'),
            containerPath: '/workspace/agent/container.json',
            readonly: true,
          },
          {
            hostPath: path.join(tmp, 'container.json'),
            containerPath: '/workspace/group/container.json',
            readonly: true,
          },
          { hostPath: path.join(tmp, 'CLAUDE.md'), containerPath: '/workspace/agent/CLAUDE.md', readonly: true },
          { hostPath: path.join(tmp, 'CLAUDE.md'), containerPath: '/workspace/group/CLAUDE.md', readonly: true },
          {
            hostPath: path.join(tmp, '.claude-fragments'),
            containerPath: '/workspace/agent/.claude-fragments',
            readonly: true,
          },
          {
            hostPath: path.join(tmp, '.claude-fragments'),
            containerPath: '/workspace/group/.claude-fragments',
            readonly: true,
          },
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
