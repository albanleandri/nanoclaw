import { spawn } from 'child_process';

import { clearContainerToolInFlight, setContainerToolInFlight } from './db/connection.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_REWRITE_OUTPUT_BYTES = 64 * 1024;

export interface ShellInput {
  command: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RewriteResult {
  verdict: 'allow' | 'passthrough' | 'deny' | 'ask';
  command?: string;
  reason?: string;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface ShellResult extends ProcessResult {
  command: string;
}

export interface ShellExecutionDependencies {
  rewrite: (command: string) => Promise<RewriteResult>;
  execute: (command: string, timeoutMs: number, maxOutputBytes: number) => Promise<ProcessResult>;
  markStart: (timeoutMs: number) => void;
  markEnd: () => void;
}

interface CapturedProcess {
  promise: Promise<ProcessResult>;
}

function captureProcess(
  executable: string,
  args: string[],
  options: { timeoutMs: number; maxOutputBytes: number; cwd?: string; detached?: boolean },
): CapturedProcess {
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: process.env,
    detached: options.detached,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let capturedBytes = 0;
  let truncated = false;
  let timedOut = false;

  const capture = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
    const remaining = options.maxOutputBytes - capturedBytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const kept = chunk.subarray(0, remaining);
    capturedBytes += kept.byteLength;
    if (kept.byteLength < chunk.byteLength) truncated = true;
    if (target === 'stdout') stdout += kept.toString();
    else stderr += kept.toString();
  };
  child.stdout?.on('data', (chunk: Buffer) => capture('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => capture('stderr', chunk));

  const stop = (signal: NodeJS.Signals): void => {
    try {
      if (options.detached && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      child.kill(signal);
    }
  };

  const promise = new Promise<ProcessResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      setTimeout(() => stop('SIGKILL'), 1_000).unref();
    }, options.timeoutMs);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: typeof code === 'number' ? code : signal ? 128 : 1,
        stdout,
        stderr,
        timedOut,
        truncated,
      });
    });
  });
  return { promise };
}

export async function rewriteWithRtk(command: string): Promise<RewriteResult> {
  const result = await captureProcess('rtk', ['rewrite', command], {
    timeoutMs: 10_000,
    maxOutputBytes: MAX_REWRITE_OUTPUT_BYTES,
  }).promise;
  const reason = result.stderr.trim() || result.stdout.trim();
  if (result.exitCode === 0) {
    const rewritten = result.stdout.trim();
    if (!rewritten) throw new Error('RTK returned an empty rewritten command');
    return { verdict: 'allow', command: rewritten };
  }
  if (result.exitCode === 1) return { verdict: 'passthrough' };
  if (result.exitCode === 2) return { verdict: 'deny', reason: reason || 'RTK denied the command' };
  if (result.exitCode === 3) return { verdict: 'ask', reason: reason || 'RTK requires approval for this command' };
  throw new Error(`RTK rewrite failed with exit code ${result.exitCode}${reason ? `: ${reason}` : ''}`);
}

/** Working directory for agent shell commands inside the container. */
export const AGENT_WORKSPACE = '/workspace/agent';

/**
 * `cwd` defaults to the container workspace and is only ever passed explicitly
 * by tests, which need a directory that exists on the host in order to
 * exercise the real capture path (truncation accounting, the SIGTERM→SIGKILL
 * escalation, and the detached process-group kill).
 */
export async function executeCommand(
  command: string,
  timeoutMs: number,
  maxOutputBytes: number,
  cwd: string = AGENT_WORKSPACE,
): Promise<ProcessResult> {
  return captureProcess('/bin/bash', ['-lc', command], {
    cwd,
    timeoutMs,
    maxOutputBytes,
    detached: true,
  }).promise;
}

const defaultDependencies: ShellExecutionDependencies = {
  rewrite: rewriteWithRtk,
  execute: executeCommand,
  markStart: (timeoutMs) => setContainerToolInFlight('mcp__nanoclaw__run_shell', timeoutMs),
  markEnd: clearContainerToolInFlight,
};

export async function executeRtkShell(
  input: ShellInput,
  dependencies: ShellExecutionDependencies = defaultDependencies,
): Promise<ShellResult> {
  const command = input.command?.trim();
  if (!command) throw new Error('command is required');
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  }
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 1024 * 1024) {
    throw new Error('maxOutputBytes must be an integer between 1024 and 1048576');
  }

  const rewrite = await dependencies.rewrite(command);
  if (rewrite.verdict === 'deny' || rewrite.verdict === 'ask') {
    throw new Error(rewrite.reason || `RTK returned ${rewrite.verdict}`);
  }
  const executableCommand = rewrite.verdict === 'allow' ? rewrite.command : command;
  if (!executableCommand) throw new Error('RTK returned no executable command');

  dependencies.markStart(timeoutMs);
  try {
    return {
      command: executableCommand,
      ...(await dependencies.execute(executableCommand, timeoutMs, maxOutputBytes)),
    };
  } finally {
    dependencies.markEnd();
  }
}
