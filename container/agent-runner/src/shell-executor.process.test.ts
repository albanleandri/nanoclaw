/**
 * Real-subprocess coverage for the run_shell execution path.
 *
 * shell-executor.test.ts covers executeRtkShell's decision logic through
 * injected dependencies, which leaves the parts that actually touch processes
 * — output truncation, the timeout kill escalation, and the RTK exit-code
 * protocol — untested. Those are the pieces where a regression silently
 * changes what an agent is allowed to run or how much output it can flood
 * back, so they are exercised here against genuine child processes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { closeSessionDb, initTestSessionDb } from './db/connection.js';
import { executeCommand, rewriteWithRtk } from './shell-executor.js';

/**
 * executeCommand's `cwd` defaults to /workspace/agent, which only exists
 * inside the container. Tests pass a real host directory so the production
 * capture path runs unchanged.
 */
describe('executeCommand — process capture', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'shell-exec-'));
  });

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('captures stdout, stderr and the exit code of a real process', async () => {
    const result = await executeCommand('echo out; echo err >&2; exit 7', 10_000, 64 * 1024, cwd);

    expect(result.exitCode).toBe(7);
    expect(result.stdout.trim()).toBe('out');
    expect(result.stderr.trim()).toBe('err');
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('runs the command in the working directory it was given', async () => {
    const result = await executeCommand('pwd', 10_000, 64 * 1024, cwd);

    expect(result.stdout.trim()).toBe(cwd);
  });

  it('truncates at the byte cap and flags the result', async () => {
    const result = await executeCommand('printf "%0.sx" {1..5000}', 10_000, 1024, cwd);

    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1024);
  });

  it('counts stdout and stderr against a single shared budget', async () => {
    // Regression guard: the cap is combined, not per-stream. If the budget
    // were tracked per-stream this would capture up to 2x the limit.
    const result = await executeCommand(
      'printf "%0.sa" {1..4000}; printf "%0.sb" {1..4000} >&2',
      10_000,
      2048,
      cwd,
    );

    expect(result.stdout.length + result.stderr.length).toBeLessThanOrEqual(2048);
    expect(result.truncated).toBe(true);
  });

  it('kills a process that overruns the timeout and reports timedOut', async () => {
    const result = await executeCommand('sleep 30', 250, 64 * 1024, cwd);

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('does not leave a detached child group running after a timeout', async () => {
    // The process-group kill is what stops `cmd &` style children from
    // outliving the timeout. Verify the whole group is gone.
    const marker = join(cwd, 'still-alive');
    const result = await executeCommand(`(sleep 30; touch ${marker}) & sleep 30`, 250, 64 * 1024, cwd);

    expect(result.timedOut).toBe(true);
    // Give SIGKILL escalation a moment, then confirm nothing wrote the marker.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  it('rejects rather than hanging when the working directory does not exist', async () => {
    await expect(
      executeCommand('echo hi', 5_000, 1024, join(cwd, 'no-such-directory')),
    ).rejects.toThrow();
  });

  it('reports a signal-terminated process as a non-zero exit', async () => {
    const result = await executeCommand('kill -TERM $$', 10_000, 1024, cwd);

    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
  });
});

describe('rewriteWithRtk — RTK exit-code protocol', () => {
  let binDir: string;
  let originalPath: string | undefined;

  /** Install a fake `rtk` on PATH that replays a scripted response. */
  function fakeRtk(script: string): void {
    const file = join(binDir, 'rtk');
    writeFileSync(file, `#!/bin/bash\n${script}\n`);
    chmodSync(file, 0o755);
  }

  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), 'fake-rtk-'));
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
    rmSync(binDir, { recursive: true, force: true });
  });

  it('exit 0 with a rewritten command means allow', async () => {
    fakeRtk('echo "rtk-wrapped git status"; exit 0');

    expect(await rewriteWithRtk('git status')).toEqual({
      verdict: 'allow',
      command: 'rtk-wrapped git status',
    });
  });

  it('exit 0 with empty output is an error, not a silent empty command', async () => {
    // Failing open here would run an empty string through bash.
    fakeRtk('exit 0');

    await expect(rewriteWithRtk('git status')).rejects.toThrow(/empty rewritten command/i);
  });

  it('exit 1 means passthrough', async () => {
    fakeRtk('exit 1');

    expect(await rewriteWithRtk('custom-tool')).toEqual({ verdict: 'passthrough' });
  });

  it('exit 2 means deny and surfaces the reason', async () => {
    fakeRtk('echo "blocked by policy" >&2; exit 2');

    expect(await rewriteWithRtk('rm -rf /')).toEqual({
      verdict: 'deny',
      reason: 'blocked by policy',
    });
  });

  it('exit 3 means ask and surfaces the reason', async () => {
    fakeRtk('echo "needs approval" >&2; exit 3');

    expect(await rewriteWithRtk('deploy prod')).toEqual({
      verdict: 'ask',
      reason: 'needs approval',
    });
  });

  it('falls back to a default reason when RTK denies without explaining', async () => {
    fakeRtk('exit 2');

    expect(await rewriteWithRtk('rm -rf /')).toEqual({
      verdict: 'deny',
      reason: 'RTK denied the command',
    });
  });

  it('throws on an unrecognised exit code rather than assuming allow', async () => {
    fakeRtk('echo "internal error" >&2; exit 42');

    await expect(rewriteWithRtk('git status')).rejects.toThrow(/exit code 42.*internal error/is);
  });
});

/**
 * The handler's happy path runs the real default dependencies, which need the
 * container filesystem (/workspace/agent as cwd, /workspace/outbound.db for
 * the tool-in-flight markers). That end-to-end path is covered in-image by
 * `pnpm run smoke:rtk-shell` (see rtk-shell-smoke.test.ts). What is testable
 * on the host — and what these cover — is the handler's contract: argument
 * coercion, error wrapping, and the audit declaration.
 */
describe('run_shell tool wiring', () => {
  beforeEach(() => initTestSessionDb());
  afterEach(() => closeSessionDb());

  it('returns a tool error instead of throwing when the command is blank', async () => {
    const { runShell } = await import('./mcp-tools/shell.js');
    const result = await runShell.handler({ command: '   ' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/^Error: .*command is required/i);
  });

  it('coerces a non-string command to empty rather than passing it through', async () => {
    const { runShell } = await import('./mcp-tools/shell.js');
    const result = await runShell.handler({ command: { evil: true } as unknown as string });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/command is required/i);
  });

  it('rejects an out-of-range timeout through the tool surface', async () => {
    const { runShell } = await import('./mcp-tools/shell.js');
    const result = await runShell.handler({ command: 'echo hi', timeout_ms: 999_999_999 });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/timeoutMs must be an integer/i);
  });

  it('rejects an out-of-range output cap through the tool surface', async () => {
    const { runShell } = await import('./mcp-tools/shell.js');
    const result = await runShell.handler({ command: 'echo hi', max_output_bytes: 10 });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/maxOutputBytes must be an integer/i);
  });

  it('never throws out of the handler — failures come back as isError results', async () => {
    // The MCP server has no catch around tool handlers, so a throw here would
    // take down the tool call rather than returning a usable error.
    const { runShell } = await import('./mcp-tools/shell.js');
    const result = await runShell.handler({ command: 'echo definitely-not-in-a-container' });

    expect(result).toHaveProperty('isError');
    expect(result.content[0]!.type).toBe('text');
  });

  it('declares run_shell as an audited, sensitive-argument capability', async () => {
    const { runShell } = await import('./mcp-tools/shell.js');

    expect(runShell.tool.name).toBe('run_shell');
    expect(runShell.audit?.capabilityId).toBe('runtime.shell');
    expect(runShell.audit?.sensitiveFields).toContain('command');
    expect(runShell.tool.inputSchema.required).toEqual(['command']);
  });
});
