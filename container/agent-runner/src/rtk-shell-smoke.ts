import type { McpToolDefinition } from './mcp-tools/types.js';
import type { ShellInput, ShellResult } from './shell-executor.js';

/**
 * Provider-neutral acceptance checks for the NanoClaw `run_shell` MCP tool.
 *
 * Claude and Codex both reach this tool through the same `mcp:nanoclaw`
 * entrypoint, so verifying the catalog entry, its capability gate, and a real
 * RTK round trip inside the image covers both runtimes without a paid provider
 * call. The per-runtime adapter list itself is asserted host-side in
 * `src/capabilities/builtins/index.test.ts`.
 *
 * Dependencies are injected so the logic is unit-testable; the release
 * acceptance run wires the real catalog and the real RTK executor
 * (`scripts/rtk-shell-container-smoke.ts`).
 */
export interface RtkShellSmokeDeps {
  listTools: () => McpToolDefinition[];
  filterTools: (tools: McpToolDefinition[], allowed: ReadonlySet<string>) => McpToolDefinition[];
  runShell: (input: ShellInput) => Promise<ShellResult>;
}

const MARKER = 'rtk-shell-smoke-ok';
const EXPECTED_EXIT_CODE = 42;
const SHELL_CAPABILITY = 'runtime.shell';

export async function runRtkShellSmoke(deps: RtkShellSmokeDeps): Promise<{ ok: true; checks: string[] }> {
  const checks: string[] = [];
  const tools = deps.listTools();

  const runShellTool = tools.find((tool) => tool.tool.name === 'run_shell');
  if (!runShellTool) throw new Error('run_shell is not registered in the container tool catalog');
  checks.push('tool-registered');

  if (runShellTool.audit?.capabilityId !== SHELL_CAPABILITY) {
    throw new Error(`run_shell must be audited under the ${SHELL_CAPABILITY} capability`);
  }
  checks.push('capability-audited');

  const granted = deps.filterTools(tools, new Set([SHELL_CAPABILITY]));
  if (!granted.some((tool) => tool.tool.name === 'run_shell')) {
    throw new Error(`run_shell is hidden despite the ${SHELL_CAPABILITY} grant`);
  }
  const withheld = deps.filterTools(tools, new Set(['nanoclaw.send-message']));
  if (withheld.some((tool) => tool.tool.name === 'run_shell')) {
    throw new Error(`run_shell is exposed without the ${SHELL_CAPABILITY} grant`);
  }
  checks.push('capability-gated');

  const succeeded = await deps.runShell({ command: `echo ${MARKER}` });
  if (succeeded.exitCode !== 0 || !succeeded.stdout.includes(MARKER)) {
    throw new Error(`run_shell did not round-trip stdout through RTK (exit ${succeeded.exitCode})`);
  }
  checks.push('rtk-round-trip');

  const failed = await deps.runShell({ command: `exit ${EXPECTED_EXIT_CODE}` });
  if (failed.exitCode !== EXPECTED_EXIT_CODE) {
    throw new Error(`run_shell reported exit code ${failed.exitCode}, expected ${EXPECTED_EXIT_CODE}`);
  }
  checks.push('exit-code-propagated');

  return { ok: true, checks };
}
