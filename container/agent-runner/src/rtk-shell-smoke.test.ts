import { describe, expect, it } from 'bun:test';

import type { McpToolDefinition } from './mcp-tools/types.js';
import { runRtkShellSmoke, type RtkShellSmokeDeps } from './rtk-shell-smoke.js';
import type { ShellResult } from './shell-executor.js';

const runShellTool: McpToolDefinition = {
  tool: { name: 'run_shell', description: 'shell', inputSchema: { type: 'object', properties: {} } },
  audit: { capabilityId: 'runtime.shell', capabilityVersion: 1 },
  handler: async () => ({ content: [] }),
};

const otherTool: McpToolDefinition = {
  tool: { name: 'send_message', description: 'send', inputSchema: { type: 'object', properties: {} } },
  audit: { capabilityId: 'nanoclaw.send-message', capabilityVersion: 1 },
  handler: async () => ({ content: [] }),
};

function shellResult(overrides: Partial<ShellResult> = {}): ShellResult {
  return {
    command: 'echo marker',
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false,
    ...overrides,
  };
}

function deps(overrides: Partial<RtkShellSmokeDeps> = {}): RtkShellSmokeDeps {
  return {
    listTools: () => [runShellTool, otherTool],
    filterTools: (tools, allowed) => tools.filter((tool) => tool.audit && allowed.has(tool.audit.capabilityId)),
    runShell: async ({ command }) =>
      command.includes('exit 42')
        ? shellResult({ command, exitCode: 42 })
        : shellResult({ command, stdout: `${command.split(' ').pop()}\n` }),
    ...overrides,
  };
}

describe('runRtkShellSmoke', () => {
  it('reports every check when the container honours the run_shell contract', async () => {
    const result = await runRtkShellSmoke(deps());

    expect(result.ok).toBe(true);
    expect(result.checks).toEqual([
      'tool-registered',
      'capability-audited',
      'capability-gated',
      'rtk-round-trip',
      'exit-code-propagated',
    ]);
  });

  it('fails when run_shell is missing from the catalog', async () => {
    await expect(runRtkShellSmoke(deps({ listTools: () => [otherTool] }))).rejects.toThrow(/run_shell is not registered/);
  });

  it('fails when run_shell is not audited under the runtime.shell capability', async () => {
    const unaudited: McpToolDefinition = { ...runShellTool, audit: undefined };
    await expect(runRtkShellSmoke(deps({ listTools: () => [unaudited, otherTool] }))).rejects.toThrow(
      /runtime\.shell/,
    );
  });

  it('fails when run_shell is exposed without the runtime.shell grant', async () => {
    await expect(runRtkShellSmoke(deps({ filterTools: (tools) => tools }))).rejects.toThrow(
      /exposed without the runtime\.shell grant/,
    );
  });

  it('fails when a successful command does not round-trip its output', async () => {
    await expect(runRtkShellSmoke(deps({ runShell: async ({ command }) => shellResult({ command }) }))).rejects.toThrow(
      /round-trip/,
    );
  });

  it('fails when a non-zero exit code is swallowed', async () => {
    await expect(
      runRtkShellSmoke(
        deps({
          runShell: async ({ command }) => shellResult({ command, stdout: `${command.split(' ').pop()}\n` }),
        }),
      ),
    ).rejects.toThrow(/exit code/);
  });
});
