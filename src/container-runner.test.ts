import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  assertUniqueMountDestinations,
  buildGroupWorkspaceMounts,
  buildMemoryAccessMounts,
  buildRtkStateMount,
  buildSessionClaudeDocMounts,
  buildSessionWorkspaceMounts,
  buildSessionRuntimeConfigMounts,
  resolveProviderName,
  syncSharedResourceSymlinks,
  syncSkillSymlinks,
} from './container-runner.js';
import { DATA_DIR } from './config.js';

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

describe('buildRtkStateMount', () => {
  it('persists provider-neutral RTK analytics and recovery output per agent group', () => {
    expect(buildRtkStateMount('ag-rtk')).toEqual({
      hostPath: path.join(DATA_DIR, 'v2-sessions', 'ag-rtk', '.rtk'),
      containerPath: '/home/node/.local/share/rtk',
      readonly: false,
    });
  });
});

describe('buildSessionWorkspaceMounts', () => {
  it('overlays the host-owned inbound database read-only after the writable session directory', () => {
    const sessionPath = path.join('/data', 'sessions', 'agent-group', 'session');

    expect(buildSessionWorkspaceMounts(sessionPath)).toEqual([
      { hostPath: sessionPath, containerPath: '/workspace', readonly: false },
      {
        hostPath: path.join(sessionPath, 'inbound.db'),
        containerPath: '/workspace/inbound.db',
        readonly: true,
      },
    ]);
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

describe('syncSharedResourceSymlinks', () => {
  it('symlinks selected shared resources and docs into groupDir/shared/', () => {
    const previousCwd = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-shared-resources-'));
    try {
      fs.mkdirSync(path.join(tmp, 'groups', 'shared', 'knowledge'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'groups', 'shared', 'trading-scripts'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
      const groupDir = path.join(tmp, 'groups', 'telegram_main');
      fs.mkdirSync(groupDir, { recursive: true });

      process.chdir(tmp);
      syncSharedResourceSymlinks(groupDir, {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
        sharedResources: ['knowledge', 'docs'],
      });

      expect(fs.readlinkSync(path.join(groupDir, 'shared', 'knowledge'))).toBe('/app/shared/knowledge');
      expect(fs.readlinkSync(path.join(groupDir, 'shared', 'docs'))).toBe('/app/docs');
      expect(fs.existsSync(path.join(groupDir, 'shared', 'trading-scripts'))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('replaces stale shared-resource links and stale directories for selected resources', () => {
    const previousCwd = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-shared-resources-'));
    try {
      fs.mkdirSync(path.join(tmp, 'groups', 'shared', 'knowledge'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
      const groupDir = path.join(tmp, 'groups', 'telegram_main');
      fs.mkdirSync(path.join(groupDir, 'shared'), { recursive: true });

      fs.symlinkSync('/old/knowledge', path.join(groupDir, 'shared', 'knowledge'));
      fs.mkdirSync(path.join(groupDir, 'shared', 'docs'));
      fs.writeFileSync(path.join(groupDir, 'shared', 'docs', 'stale.txt'), 'stale');

      process.chdir(tmp);
      syncSharedResourceSymlinks(groupDir, {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all',
        sharedResources: ['knowledge', 'docs'],
      });

      expect(fs.readlinkSync(path.join(groupDir, 'shared', 'knowledge'))).toBe('/app/shared/knowledge');
      expect(fs.readlinkSync(path.join(groupDir, 'shared', 'docs'))).toBe('/app/docs');
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('removes a symlink when its resource is deselected', () => {
    const previousCwd = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-shared-resources-'));
    try {
      fs.mkdirSync(path.join(tmp, 'groups', 'shared', 'knowledge'), { recursive: true });
      const groupDir = path.join(tmp, 'groups', 'telegram_main');
      fs.mkdirSync(groupDir, { recursive: true });
      process.chdir(tmp);
      const config = {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: 'all' as const,
        sharedResources: ['knowledge'],
      };
      syncSharedResourceSymlinks(groupDir, config);
      expect(fs.lstatSync(path.join(groupDir, 'shared', 'knowledge')).isSymbolicLink()).toBe(true);
      syncSharedResourceSymlinks(groupDir, { ...config, sharedResources: [] });
      expect(fs.existsSync(path.join(groupDir, 'shared', 'knowledge'))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('buildGroupWorkspaceMounts', () => {
  it('mounts both workspace aliases with shared managed overlays but no group runtime config overlay', () => {
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
      expect(mounts).not.toContainEqual(expect.objectContaining({ containerPath: '/workspace/agent/container.json' }));
      expect(mounts).not.toContainEqual(expect.objectContaining({ containerPath: '/workspace/group/container.json' }));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('buildMemoryAccessMounts', () => {
  const memoryProfile = {
    workspacePath: '/workspace/agent',
    localMemoryFile: 'CLAUDE.local.md',
    neutralMemoryRoot: '/workspace/agent/memory',
    indexPath: 'index.md',
    definitionPath: 'system/definition.md',
    conversationsPath: '/workspace/agent/conversations',
    mode: 'shadow' as const,
    access: 'read-only' as const,
    okfVersion: '0.1' as const,
    indexMaxBytes: 12 * 1024,
    definitionMaxBytes: 8 * 1024,
    renderedMaxBytes: 24 * 1024,
  };

  it('overlays both workspace aliases read-only for a non-writer session', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-mounts-'));
    try {
      fs.mkdirSync(path.join(tmp, 'memory'), { mode: 0o700 });
      expect(buildMemoryAccessMounts(tmp, memoryProfile)).toEqual([
        {
          hostPath: path.join(tmp, 'memory'),
          containerPath: '/workspace/agent/memory',
          readonly: true,
        },
        {
          hostPath: path.join(tmp, 'memory'),
          containerPath: '/workspace/group/memory',
          readonly: true,
        },
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('adds no overlay for disabled memory or the designated writer', () => {
    expect(buildMemoryAccessMounts('/missing', { ...memoryProfile, mode: 'disabled', access: 'none' })).toEqual([]);
    expect(buildMemoryAccessMounts('/missing', { ...memoryProfile, access: 'read-write' })).toEqual([]);
  });

  it('fails closed for missing, symlinked, or writable memory roots', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-unsafe-'));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-target-'));
    try {
      expect(() => buildMemoryAccessMounts(tmp, memoryProfile)).toThrow('unavailable');
      fs.symlinkSync(target, path.join(tmp, 'memory'));
      expect(() => buildMemoryAccessMounts(tmp, memoryProfile)).toThrow('unsafe');
      fs.rmSync(path.join(tmp, 'memory'));
      fs.mkdirSync(path.join(tmp, 'memory'), { mode: 0o777 });
      fs.chmodSync(path.join(tmp, 'memory'), 0o777);
      expect(() => buildMemoryAccessMounts(tmp, memoryProfile)).toThrow('unsafe mode');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('rejects a later mount that could punch through the protected subtree', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-collision-'));
    try {
      fs.mkdirSync(path.join(tmp, 'memory'), { mode: 0o700 });
      expect(() =>
        buildMemoryAccessMounts(tmp, memoryProfile, [
          {
            hostPath: '/host/override',
            containerPath: '/workspace/agent/memory/system',
            readonly: false,
          },
        ]),
      ).toThrow('Mount conflicts with protected memory subtree');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('buildSessionClaudeDocMounts', () => {
  it('overlays both workspace aliases from one session-private source', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-session-docs-'));
    try {
      fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# Session');
      fs.mkdirSync(path.join(tmp, '.claude-fragments'));
      const mounts = buildSessionClaudeDocMounts(tmp);
      expect(mounts).toHaveLength(4);
      expect(mounts).toContainEqual({
        hostPath: path.join(tmp, 'CLAUDE.md'),
        containerPath: '/workspace/agent/CLAUDE.md',
        readonly: true,
      });
      expect(() => assertUniqueMountDestinations(mounts)).not.toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('session runtime config mounts', () => {
  it('composes with group workspace mounts without duplicate destinations', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-runtime-mounts-'));
    try {
      fs.writeFileSync(path.join(tmp, 'container.json'), '{}');
      const runtimeConfigPath = path.join(tmp, 'container.runtime.json');
      fs.writeFileSync(runtimeConfigPath, '{}');

      const mounts = [...buildGroupWorkspaceMounts(tmp), ...buildSessionRuntimeConfigMounts(runtimeConfigPath)];

      expect(buildSessionRuntimeConfigMounts(runtimeConfigPath)).toEqual([
        {
          hostPath: runtimeConfigPath,
          containerPath: '/workspace/agent/container.json',
          readonly: true,
        },
        {
          hostPath: runtimeConfigPath,
          containerPath: '/workspace/group/container.json',
          readonly: true,
        },
      ]);
      expect(() => assertUniqueMountDestinations(mounts)).not.toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects duplicate destinations before Docker is invoked', () => {
    expect(() =>
      assertUniqueMountDestinations([
        { hostPath: '/host/group.json', containerPath: '/workspace/agent/container.json', readonly: true },
        { hostPath: '/host/runtime.json', containerPath: '/workspace/agent/container.json/', readonly: true },
      ]),
    ).toThrow('Duplicate container mount destination: /workspace/agent/container.json');
  });
});
