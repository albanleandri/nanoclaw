import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findUnregisteredGroupFolders } from './index.js';

describe('findUnregisteredGroupFolders', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-integrity-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when groups dir does not exist', () => {
    expect(
      findUnregisteredGroupFolders('/nonexistent/path', new Set()),
    ).toEqual([]);
  });

  it('returns empty array when all folders with CLAUDE.md are registered', () => {
    const folder = path.join(tmpDir, 'telegram_main');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'CLAUDE.md'), '# Andy');

    expect(
      findUnregisteredGroupFolders(tmpDir, new Set(['telegram_main'])),
    ).toEqual([]);
  });

  it('returns folder when CLAUDE.md exists but folder is not registered', () => {
    const folder = path.join(tmpDir, 'telegram_main');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'CLAUDE.md'), '# Andy');

    expect(findUnregisteredGroupFolders(tmpDir, new Set())).toEqual([
      'telegram_main',
    ]);
  });

  it('skips folders without CLAUDE.md', () => {
    fs.mkdirSync(path.join(tmpDir, 'telegram_main'));
    // No CLAUDE.md written — should not be flagged

    expect(findUnregisteredGroupFolders(tmpDir, new Set())).toEqual([]);
  });

  it('skips main and global template directories', () => {
    for (const name of ['main', 'global']) {
      const folder = path.join(tmpDir, name);
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, 'CLAUDE.md'), '# Andy');
    }

    expect(findUnregisteredGroupFolders(tmpDir, new Set())).toEqual([]);
  });

  it('detects multiple unregistered folders', () => {
    for (const name of ['telegram_main', 'slack_work']) {
      const folder = path.join(tmpDir, name);
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, 'CLAUDE.md'), '# Andy');
    }

    const result = findUnregisteredGroupFolders(tmpDir, new Set());
    expect(result).toHaveLength(2);
    expect(result).toContain('telegram_main');
    expect(result).toContain('slack_work');
  });

  it('does not flag registered folders even when they have CLAUDE.md', () => {
    for (const name of ['telegram_main', 'slack_work']) {
      const folder = path.join(tmpDir, name);
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, 'CLAUDE.md'), '# Andy');
    }

    // Only telegram_main is registered
    const result = findUnregisteredGroupFolders(
      tmpDir,
      new Set(['telegram_main']),
    );
    expect(result).toEqual(['slack_work']);
  });

  it('ignores non-directory entries', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Andy');

    expect(findUnregisteredGroupFolders(tmpDir, new Set())).toEqual([]);
  });
});
