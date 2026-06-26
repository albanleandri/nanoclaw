import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getLaunchdLabel, getSystemdUnit } from '../src/install-slug.js';
import { cleanupUnhealthyPeers, shouldUnloadPeer, systemdShowTargetsProject } from './peer-cleanup.js';

const created: string[] = [];

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-cleanup-'));
  created.push(dir);
  return dir;
}

function writePlist(filePath: string, target: string): void {
  fs.writeFileSync(
    filePath,
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/node</string><string>${target}</string></array>
</dict></plist>`,
  );
}

function writeUnit(filePath: string, target: string): void {
  fs.writeFileSync(filePath, `[Service]\nExecStart=/usr/bin/node ${target}\n`);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('systemdShowTargetsProject', () => {
  const projectRoot = '/home/nanoclaw/nanoclaw-v2';

  it('detects a duplicate unit by absolute effective ExecStart', () => {
    const output = [
      'ActiveState=active',
      'NRestarts=0',
      'ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /home/nanoclaw/nanoclaw-v2/dist/index.js ; }',
      'WorkingDirectory=/tmp/other',
    ].join('\n');

    expect(systemdShowTargetsProject(output, projectRoot)).toBe(true);
  });

  it('detects a duplicate unit by relative dist index with matching WorkingDirectory', () => {
    const output = [
      'ActiveState=active',
      'NRestarts=0',
      'ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node dist/index.js ; }',
      'WorkingDirectory=/home/nanoclaw/nanoclaw-v2',
    ].join('\n');

    expect(systemdShowTargetsProject(output, projectRoot)).toBe(true);
  });

  it('does not classify helper services that only share WorkingDirectory', () => {
    const output = [
      'ActiveState=inactive',
      'NRestarts=0',
      'ExecStart={ path=/home/nanoclaw/nanoclaw-v2/scripts/refresh-onecli-token.sh ; argv[]=/home/nanoclaw/nanoclaw-v2/scripts/refresh-onecli-token.sh ; }',
      'WorkingDirectory=/home/nanoclaw/nanoclaw-v2',
    ].join('\n');

    expect(systemdShowTargetsProject(output, projectRoot)).toBe(false);
  });

  it('leaves unrelated peer installs alone', () => {
    const output = [
      'ActiveState=active',
      'NRestarts=0',
      'ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /srv/other-nanoclaw/dist/index.js ; }',
      'WorkingDirectory=/srv/other-nanoclaw',
    ].join('\n');

    expect(systemdShowTargetsProject(output, projectRoot)).toBe(false);
  });
});

describe('shouldUnloadPeer', () => {
  it('unloads crash-looping peers', () => {
    expect(shouldUnloadPeer({ unhealthy: true, duplicateCurrentInstall: false })).toBe(true);
  });

  it('unloads healthy duplicate units for this checkout', () => {
    expect(shouldUnloadPeer({ unhealthy: false, duplicateCurrentInstall: true })).toBe(true);
  });

  it('keeps healthy unrelated peers', () => {
    expect(shouldUnloadPeer({ unhealthy: false, duplicateCurrentInstall: false })).toBe(false);
  });
});

describe('cleanupUnhealthyPeers dead registrations', () => {
  it('removes a launchd plist whose target binary is gone', () => {
    const home = tempHome();
    const agentsDir = path.join(home, 'Library', 'LaunchAgents');
    const projectRoot = path.join(home, 'install');
    fs.mkdirSync(agentsDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(os, 'platform').mockReturnValue('darwin');

    const dead = path.join(agentsDir, 'com.nanoclaw-v2-dead.plist');
    writePlist(dead, path.join(home, 'gone', 'dist', 'index.js'));

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(fs.existsSync(dead)).toBe(false);
    expect(result.removed.map((r) => r.label)).toContain('com.nanoclaw-v2-dead');
  });

  it('leaves this install launchd plist alone even if its target is missing', () => {
    const home = tempHome();
    const agentsDir = path.join(home, 'Library', 'LaunchAgents');
    const projectRoot = path.join(home, 'install');
    fs.mkdirSync(agentsDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(os, 'platform').mockReturnValue('darwin');

    const own = path.join(agentsDir, `${getLaunchdLabel(projectRoot)}.plist`);
    writePlist(own, path.join(home, 'gone', 'dist', 'index.js'));

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(fs.existsSync(own)).toBe(true);
    expect(result.removed).toHaveLength(0);
  });

  it('removes a systemd unit whose target binary is gone', () => {
    const home = tempHome();
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    const projectRoot = path.join(home, 'install');
    fs.mkdirSync(unitDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(os, 'platform').mockReturnValue('linux');

    const dead = path.join(unitDir, 'nanoclaw-v2-dead.service');
    writeUnit(dead, path.join(home, 'gone', 'dist', 'index.js'));

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(fs.existsSync(dead)).toBe(false);
    expect(result.removed.map((r) => r.label)).toContain('nanoclaw-v2-dead');
  });

  it('leaves this install systemd unit alone', () => {
    const home = tempHome();
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    const projectRoot = path.join(home, 'install');
    fs.mkdirSync(unitDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(os, 'platform').mockReturnValue('linux');

    const own = path.join(unitDir, `${getSystemdUnit(projectRoot)}.service`);
    writeUnit(own, path.join(home, 'gone', 'dist', 'index.js'));

    const result = cleanupUnhealthyPeers(projectRoot);

    expect(fs.existsSync(own)).toBe(true);
    expect(result.removed).toHaveLength(0);
  });
});
