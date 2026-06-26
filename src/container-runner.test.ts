import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  buildGroupWorkspaceMounts,
  resolveProviderName,
  syncSharedResourceSymlinks,
  syncSkillSymlinks,
} from './container-runner.js';

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

describe('buildContainerArgs ordering invariant (structural)', () => {
  // The OneCLI gateway apply (SDK applyContainerConfig) appends credential-stub
  // mounts — e.g. the codex auth.json sentinel nested INSIDE our RW
  // /home/node/.codex mount. Docker applies binds in argument order, so the
  // stub must land AFTER its parent mount or the parent shadows it and the
  // agent silently degrades to loginless auth. Driving the real
  // buildContainerArgs needs a live gateway + container runtime, so this
  // guards the invariant structurally: the gateway apply must appear after
  // the volume-mounts loop in the source.
  it('applies the OneCLI gateway after the volume mounts', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const mountsLoop = src.indexOf('for (const mount of mounts)');
    const gatewayApply = src.indexOf('onecli.applyContainerConfig');
    expect(mountsLoop).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(mountsLoop);
  });
});

describe('per-container resource limits (structural)', () => {
  it('reads both limit knobs from config', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('CONTAINER_CPU_LIMIT');
    expect(src).toContain('CONTAINER_MEMORY_LIMIT');
  });

  it('guards --cpus behind a truthy CONTAINER_CPU_LIMIT', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/if \(CONTAINER_CPU_LIMIT\) args\.push\('--cpus', CONTAINER_CPU_LIMIT\)/);
  });

  it('guards --memory behind a truthy CONTAINER_MEMORY_LIMIT and does not set swap policy', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/if \(CONTAINER_MEMORY_LIMIT\) args\.push\('--memory', CONTAINER_MEMORY_LIMIT\)/);
    expect(src).not.toContain('--memory-swap');
  });

  it('defaults both knobs to empty string in config', () => {
    const cfg = fs.readFileSync(path.join(process.cwd(), 'src', 'config.ts'), 'utf-8');
    expect(cfg).toContain("CONTAINER_CPU_LIMIT || envConfig.CONTAINER_CPU_LIMIT || ''");
    expect(cfg).toContain("CONTAINER_MEMORY_LIMIT || envConfig.CONTAINER_MEMORY_LIMIT || ''");
  });
});

describe('egress lockdown wiring (structural)', () => {
  it('selects the lockdown network instead of the host gateway when enabled', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('ensureEgressNetwork');
    expect(src).toMatch(/if \(ensureEgressNetwork\(\)\)[\s\S]*?args\.push\(\.\.\.egressNetworkArgs\(\)\)/);
    expect(src).toMatch(/else \{[\s\S]*?args\.push\(\.\.\.hostGatewayArgs\(\)\)/);
  });

  it('keeps the OneCLI gateway apply after volume mounts while egress wiring stays before it', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const egressCheck = src.indexOf('ensureEgressNetwork()');
    const mountsLoop = src.indexOf('for (const mount of mounts)');
    const gatewayApply = src.indexOf('onecli.applyContainerConfig');
    expect(egressCheck).toBeGreaterThan(-1);
    expect(mountsLoop).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(mountsLoop);
    expect(gatewayApply).toBeGreaterThan(egressCheck);
  });

  it('defines opt-in egress lockdown config with .env fallback', () => {
    const cfg = fs.readFileSync(path.join(process.cwd(), 'src', 'config.ts'), 'utf-8');
    expect(cfg).toContain('NANOCLAW_EGRESS_LOCKDOWN');
    expect(cfg).toContain("NANOCLAW_EGRESS_NETWORK || envConfig.NANOCLAW_EGRESS_NETWORK || 'nanoclaw-egress'");
    expect(cfg).toContain("ONECLI_GATEWAY_CONTAINER || envConfig.ONECLI_GATEWAY_CONTAINER || 'onecli'");
  });
});

describe('container boot-failure tripwire (structural)', () => {
  it('surfaces the stderr tail when the container exits non-zero', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('stderrTail.push(line)');
    expect(src).toMatch(/Container exited non-zero.*stderrTail/s);
  });
});
