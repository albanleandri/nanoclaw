import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { runAudit, scanTaskDb, scanText } from './model-neutral-audit.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-neutral-audit-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('model-neutral audit', () => {
  it('classifies provider, compatibility, channel, fixture, and blocker findings', () => {
    const findings = scanText(
      'container/skills/sample/SKILL.md',
      'Read /workspace/group. Call Skill(x), use Sonnet, bot_index, and ag-123456789-test.',
    );
    expect(findings.map((finding) => finding.category)).toEqual([
      'provider-compatible-fallback',
      'provider-specific',
      'provider-specific',
      'channel-specific',
      'blocker',
    ]);
    expect(scanText('src/sample.test.ts', 'use Sonnet')[0]?.category).toBe('test-fixture');
  });

  it('reads task rows through a query-only database without exposing content by default', () => {
    const root = tempDir();
    const dbPath = path.join(root, 'inbound.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE messages_in (id TEXT, kind TEXT, status TEXT, content TEXT)');
    db.prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?)').run(
      'task-1',
      'task',
      'pending',
      'Use /home/node/.claude/skills/private-value',
    );
    db.close();

    const findings = scanTaskDb(dbPath, root);
    expect(findings).toMatchObject([
      {
        source: 'inbound.db#task:task-1',
        surface: 'live-task',
        pattern: '/home/node/.claude/skills',
      },
    ]);
    expect(findings[0]?.excerpt).toBeUndefined();
  });

  it('scans configured active roots deterministically', () => {
    const root = tempDir();
    const skillDir = path.join(root, 'container', 'skills', 'sample');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'Use /workspace/group and bot_index');
    expect(runAudit(root).map((finding) => finding.pattern)).toEqual(['/workspace/group', 'bot_index']);
  });
});
