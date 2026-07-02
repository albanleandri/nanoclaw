import { describe, expect, it } from 'bun:test';

import { executeRtkShell, type ShellExecutionDependencies } from './shell-executor.js';

function dependencies(
  overrides: Partial<ShellExecutionDependencies> = {},
): ShellExecutionDependencies & { executed: string[]; lifecycle: string[] } {
  const executed: string[] = [];
  const lifecycle: string[] = [];
  return {
    executed,
    lifecycle,
    rewrite: async (command) => ({ verdict: 'allow', command: `rtk ${command}` }),
    execute: async (command) => {
      executed.push(command);
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, truncated: false };
    },
    markStart: () => lifecycle.push('start'),
    markEnd: () => lifecycle.push('end'),
    ...overrides,
  };
}

describe('executeRtkShell', () => {
  it('executes the RTK-rewritten command and reports the underlying exit result', async () => {
    const deps = dependencies();

    const result = await executeRtkShell({ command: 'git status', timeoutMs: 12_000 }, deps);

    expect(deps.executed).toEqual(['rtk git status']);
    expect(deps.lifecycle).toEqual(['start', 'end']);
    expect(result).toEqual({
      command: 'rtk git status',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      timedOut: false,
      truncated: false,
    });
  });

  it('executes the original command when RTK declares passthrough', async () => {
    const deps = dependencies({ rewrite: async () => ({ verdict: 'passthrough' }) });

    await executeRtkShell({ command: 'custom-tool --version' }, deps);

    expect(deps.executed).toEqual(['custom-tool --version']);
  });

  it('fails closed without executing when RTK denies or requires approval', async () => {
    for (const verdict of ['deny', 'ask'] as const) {
      const deps = dependencies({ rewrite: async () => ({ verdict, reason: `rewrite ${verdict}` }) });

      await expect(executeRtkShell({ command: 'dangerous-command' }, deps)).rejects.toThrow(`rewrite ${verdict}`);
      expect(deps.executed).toEqual([]);
      expect(deps.lifecycle).toEqual([]);
    }
  });

  it('clears lifecycle state after command execution fails', async () => {
    const deps = dependencies({
      execute: async () => {
        throw new Error('spawn failed');
      },
    });

    await expect(executeRtkShell({ command: 'git status' }, deps)).rejects.toThrow('spawn failed');
    expect(deps.lifecycle).toEqual(['start', 'end']);
  });

  it('rejects empty commands and out-of-range timeouts', async () => {
    const deps = dependencies();

    await expect(executeRtkShell({ command: '  ' }, deps)).rejects.toThrow(/command/i);
    await expect(executeRtkShell({ command: 'true', timeoutMs: 0 }, deps)).rejects.toThrow(/timeout/i);
    await expect(executeRtkShell({ command: 'true', timeoutMs: 700_000 }, deps)).rejects.toThrow(/timeout/i);
  });
});
