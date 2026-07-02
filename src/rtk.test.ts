import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureRtkClaudeHook } from './rtk.js';

describe('ensureRtkClaudeHook', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function settingsPath(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-rtk-'));
    roots.push(root);
    return path.join(root, 'settings.json');
  }

  it('adds the Claude Bash hook while preserving unrelated settings and hooks', () => {
    const file = settingsPath();
    fs.writeFileSync(
      file,
      JSON.stringify({
        env: { EXISTING: 'yes' },
        hooks: {
          PreCompact: [{ hooks: [{ type: 'command', command: 'compact' }] }],
          PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'audit-write' }] }],
        },
      }),
    );

    expect(ensureRtkClaudeHook(file)).toBe('updated');

    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(settings.env).toEqual({ EXISTING: 'yes' });
    expect(settings.hooks.PreCompact).toHaveLength(1);
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: 'Write', hooks: [{ type: 'command', command: 'audit-write' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] },
    ]);
  });

  it('is idempotent when the RTK hook already exists', () => {
    const file = settingsPath();
    const content =
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }],
          },
        },
        null,
        2,
      ) + '\n';
    fs.writeFileSync(file, content);

    expect(ensureRtkClaudeHook(file)).toBe('unchanged');
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
  });

  it('adds the Bash hook when the RTK command exists only under a non-matching tool', () => {
    const file = settingsPath();
    fs.writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'rtk hook claude' }] }],
        },
      }),
    );

    expect(ensureRtkClaudeHook(file)).toBe('updated');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(settings.hooks.PreToolUse.at(-1).matcher).toBe('Bash');
  });

  it('refuses malformed JSON without overwriting operator settings', () => {
    const file = settingsPath();
    fs.writeFileSync(file, '{ malformed');

    expect(() => ensureRtkClaudeHook(file)).toThrow(/invalid JSON/i);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ malformed');
  });

  it('refuses invalid hook shapes without overwriting operator settings', () => {
    const file = settingsPath();
    const content = JSON.stringify({ hooks: { PreToolUse: 'not-an-array' } });
    fs.writeFileSync(file, content);

    expect(() => ensureRtkClaudeHook(file)).toThrow(/PreToolUse.*array/i);
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
  });
});
