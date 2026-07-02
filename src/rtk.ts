import fs from 'fs';
import path from 'path';

export const RTK_CLAUDE_HOOK_COMMAND = 'rtk hook claude';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matcherIncludesBash(matcher: unknown): boolean {
  if (matcher === undefined || matcher === '') return true;
  if (typeof matcher !== 'string') return false;
  try {
    return new RegExp(matcher).test('Bash');
  } catch {
    return false;
  }
}

function writeJsonAtomic(filePath: string, value: JsonObject): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    if (fs.existsSync(filePath)) fs.chmodSync(tmp, fs.statSync(filePath).mode);
    fs.renameSync(tmp, filePath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Ensure Claude's native Bash compatibility hook delegates through RTK.
 * Existing settings are preserved exactly at the object/array level. Invalid
 * operator-owned JSON fails closed and is never replaced.
 */
export function ensureRtkClaudeHook(settingsFile: string): 'updated' | 'unchanged' {
  let settings: JsonObject = {};
  if (fs.existsSync(settingsFile)) {
    const raw = fs.readFileSync(settingsFile, 'utf8');
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isObject(parsed)) throw new Error('settings root must be an object');
      settings = parsed;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot install RTK hook: ${settingsFile} contains invalid JSON (${reason})`, { cause: error });
    }
  }

  const hooksValue = settings.hooks;
  if (hooksValue !== undefined && !isObject(hooksValue)) {
    throw new Error(`Cannot install RTK hook: ${settingsFile} hooks must be an object`);
  }
  const hooks = hooksValue ?? {};
  const preToolUseValue = hooks.PreToolUse;
  if (preToolUseValue !== undefined && !Array.isArray(preToolUseValue)) {
    throw new Error(`Cannot install RTK hook: ${settingsFile} hooks.PreToolUse must be an array`);
  }
  const preToolUse = preToolUseValue ?? [];
  const hasRtkHook = preToolUse.some(
    (entry) =>
      isObject(entry) &&
      matcherIncludesBash(entry.matcher) &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some((hook) => isObject(hook) && hook.command === RTK_CLAUDE_HOOK_COMMAND),
  );
  if (hasRtkHook) return 'unchanged';

  settings.hooks = {
    ...hooks,
    PreToolUse: [
      ...preToolUse,
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: RTK_CLAUDE_HOOK_COMMAND }],
      },
    ],
  };
  writeJsonAtomic(settingsFile, settings);
  return 'updated';
}
