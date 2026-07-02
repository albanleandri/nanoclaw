import { executeRtkShell } from '../shell-executor.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function renderResult(result: Awaited<ReturnType<typeof executeRtkShell>>): string {
  const sections = [
    `command: ${result.command}`,
    `exit_code: ${result.exitCode}`,
    `timed_out: ${result.timedOut}`,
    `truncated: ${result.truncated}`,
  ];
  if (result.stdout) sections.push(`stdout:\n${result.stdout.trimEnd()}`);
  if (result.stderr) sections.push(`stderr:\n${result.stderr.trimEnd()}`);
  return sections.join('\n');
}

export const runShell: McpToolDefinition = {
  tool: {
    name: 'run_shell',
    description:
      'Run a shell command in /workspace/agent through RTK token filtering. Prefer this over a provider-native shell. Commands that RTK denies or marks as requiring approval are not executed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Bash command to execute' },
        timeout_ms: {
          type: 'integer',
          minimum: 1,
          maximum: 600_000,
          description: 'Execution timeout in milliseconds (default 120000, maximum 600000)',
        },
        max_output_bytes: {
          type: 'integer',
          minimum: 1024,
          maximum: 1_048_576,
          description: 'Combined stdout/stderr capture limit (default 262144)',
        },
      },
      required: ['command'],
    },
  },
  audit: {
    capabilityId: 'runtime.shell',
    capabilityVersion: 1,
    sensitiveFields: ['command'],
  },
  async handler(args) {
    try {
      const result = await executeRtkShell({
        command: typeof args.command === 'string' ? args.command : '',
        timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
        maxOutputBytes: typeof args.max_output_bytes === 'number' ? args.max_output_bytes : undefined,
      });
      return {
        content: [{ type: 'text' as const, text: renderResult(result) }],
        isError: result.exitCode !== 0 || result.timedOut,
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
};

registerTools([runShell]);
