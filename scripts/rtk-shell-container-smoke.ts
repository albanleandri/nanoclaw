/**
 * Release-acceptance smoke for the provider-neutral `run_shell` MCP tool.
 *
 * Runs INSIDE the agent image (see docs/OPERATIONS.md): mounts an empty
 * writable directory at /workspace/agent, mounts this checkout read-only at
 * /repo, then `bun /repo/scripts/rtk-shell-container-smoke.ts`.
 *
 * It exercises the real tool catalog, the real capability gate, and real RTK
 * rewriting plus process execution — the contract Claude and Codex share. No
 * provider call is made, so it costs nothing and needs no credentials.
 */
import { initTestSessionDb } from '../container/agent-runner/src/db/connection.js';
import '../container/agent-runner/src/mcp-tools/catalog.js';
import { filterToolsByCapability, listRegisteredToolDefinitions } from '../container/agent-runner/src/mcp-tools/server.js';
import { runRtkShellSmoke } from '../container/agent-runner/src/rtk-shell-smoke.js';
import { executeRtkShell } from '../container/agent-runner/src/shell-executor.js';

// Container-state lifecycle tracking (markStart/markEnd) writes to the session
// outbound DB; an in-memory session DB keeps the smoke free of live group data.
initTestSessionDb();

const result = await runRtkShellSmoke({
  listTools: listRegisteredToolDefinitions,
  filterTools: filterToolsByCapability,
  runShell: (input) => executeRtkShell(input),
});

process.stdout.write(`${JSON.stringify(result)}\n`);
