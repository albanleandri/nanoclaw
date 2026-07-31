import { registerCapability } from '../capability-registry.js';

registerCapability({
  id: 'nanoclaw.send-message',
  version: 1,
  description: 'Deliver a message to an authorized channel destination through the host.',
  requirements: {},
  sideEffects: 'external-write',
  approval: 'never',
  adapters: [
    { kind: 'host-action', entrypoint: 'host:send-message' },
    { kind: 'protocol-tool', runtimeIds: ['openai-protocol-loop'], entrypoint: 'tool:send_message' },
  ],
  mcpTools: ['add_reaction', 'ask_user_question', 'edit_message', 'send_card', 'send_file', 'send_message'],
});

registerCapability({
  id: 'nanoclaw.manage-agents',
  version: 1,
  description: 'Create and wire persistent agent groups.',
  requirements: { durableState: true },
  sideEffects: 'local-write',
  approval: 'policy',
  adapters: [{ kind: 'host-action', entrypoint: 'host:create-agent' }],
  mcpTools: ['create_agent'],
});

registerCapability({
  id: 'nanoclaw.self-modify',
  version: 1,
  description: 'Request changes to the agent container package and MCP configuration.',
  requirements: { durableState: true },
  sideEffects: 'credentialed',
  approval: 'always',
  adapters: [
    { kind: 'host-action', entrypoint: 'host:install-packages' },
    { kind: 'host-action', entrypoint: 'host:add-mcp-server' },
  ],
  mcpTools: ['add_mcp_server', 'install_packages'],
});

registerCapability({
  id: 'nanoclaw.manage-jobs',
  version: 1,
  description: 'Start, inspect, and cancel durable background jobs.',
  requirements: { durableState: true },
  sideEffects: 'local-write',
  approval: 'policy',
  adapters: [
    { kind: 'host-action', entrypoint: 'host:start-job' },
    { kind: 'host-action', entrypoint: 'host:get-job-status' },
    { kind: 'host-action', entrypoint: 'host:cancel-job' },
  ],
  mcpTools: ['cancel_job', 'get_job_status', 'start_job'],
});

registerCapability({
  id: 'nanoclaw.cli',
  version: 1,
  description: 'Dispatch an ncl command through the host with the configured CLI scope.',
  requirements: { durableState: true },
  sideEffects: 'local-write',
  approval: 'policy',
  adapters: [{ kind: 'host-action', entrypoint: 'host:cli-request' }],
});

registerCapability({
  id: 'nanoclaw.external-mcp',
  version: 1,
  description: 'Connect the runtime to operator-configured external MCP servers.',
  requirements: { toolCalling: 'native-or-bridged', mcp: true },
  sideEffects: 'credentialed',
  approval: 'policy',
  adapters: [
    {
      kind: 'mcp',
      runtimeIds: ['claude-sdk', 'codex-app-server'],
      entrypoint: 'mcp:configured',
    },
  ],
});

for (const taskTool of [
  ['nanoclaw.request-agent-task', 'request_agent_task'],
  ['nanoclaw.get-agent-task', 'get_agent_task'],
  ['nanoclaw.cancel-agent-task', 'cancel_agent_task'],
  ['nanoclaw.report-agent-task-progress', 'report_agent_task_progress'],
  ['nanoclaw.block-agent-task', 'block_agent_task'],
  ['nanoclaw.complete-agent-task', 'complete_agent_task'],
  ['nanoclaw.fail-agent-task', 'fail_agent_task'],
  ['nanoclaw.publish-agent-task-artifact', 'publish_agent_task_artifact'],
] as const) {
  registerCapability({
    id: taskTool[0],
    version: 1,
    description: `Durable cross-agent task operation: ${taskTool[1]}.`,
    requirements: { durableState: true },
    sideEffects: taskTool[1] === 'get_agent_task' ? 'none' : 'local-write',
    approval: 'policy',
    adapters: [
      { kind: 'host-action', entrypoint: `host:${taskTool[1].replaceAll('_', '-')}` },
      { kind: 'protocol-tool', runtimeIds: ['openai-protocol-loop'], entrypoint: `tool:${taskTool[1]}` },
    ],
    mcpTools: [taskTool[1]],
  });
}

registerCapability({
  id: 'nanoclaw.schedule-task',
  version: 2,
  description: 'Schedule a future inbound wake through the host.',
  requirements: { durableState: true },
  sideEffects: 'local-write',
  approval: 'never',
  adapters: [
    { kind: 'host-action', entrypoint: 'host:schedule-task' },
    { kind: 'protocol-tool', runtimeIds: ['openai-protocol-loop'], entrypoint: 'tool:schedule_task' },
  ],
  // D4: the runner surfaces exactly one MCP tool for this capability now —
  // `schedule_task`, the openai-protocol-loop shim. The other five moved to
  // `ncl tasks`, so declaring them here would let a forged `tool:list_tasks`
  // audit event through for a tool that no longer exists. Pinned from both
  // sides by contracts/mcp-tool-capabilities.json.
  mcpTools: ['schedule_task'],
});

registerCapability({
  id: 'memory.session-search',
  version: 1,
  description: 'Search source-attributed text from this agent group’s prior sessions.',
  requirements: { toolCalling: 'native-or-bridged', durableState: true },
  sideEffects: 'none',
  approval: 'never',
  adapters: [
    { kind: 'host-action', entrypoint: 'host:session-search' },
    { kind: 'protocol-tool', runtimeIds: ['openai-protocol-loop'], entrypoint: 'tool:session_search' },
  ],
  mcpTools: ['session_search'],
});

registerCapability({
  id: 'nanoclaw.browse-web',
  version: 1,
  description: 'Fetch and sanitize web pages through the built-in NanoClaw MCP server.',
  requirements: { toolCalling: 'native-or-bridged', mcp: true, network: true },
  sideEffects: 'none',
  approval: 'policy',
  adapters: [
    {
      kind: 'mcp',
      runtimeIds: ['claude-sdk', 'codex-app-server'],
      entrypoint: 'mcp:nanoclaw',
    },
  ],
  mcpTools: ['browse_web'],
});

registerCapability({
  id: 'web.browse',
  version: 1,
  description: 'Fetch and read web pages through a configured browser MCP server.',
  requirements: { toolCalling: 'native-or-bridged', mcp: true, network: true },
  sideEffects: 'none',
  approval: 'policy',
  adapters: [
    {
      kind: 'mcp',
      runtimeIds: ['claude-sdk', 'codex-app-server'],
      entrypoint: 'mcp:browser',
      availabilityCheck: 'mcp-server-configured',
    },
  ],
});

registerCapability({
  id: 'repo.edit',
  version: 1,
  description: 'Read and write files in the session workspace.',
  requirements: { toolCalling: 'native-or-bridged', workspace: 'write' },
  sideEffects: 'local-write',
  approval: 'policy',
  adapters: [
    {
      kind: 'native-runtime',
      runtimeIds: ['claude-sdk', 'codex-app-server'],
      entrypoint: 'native:fs',
    },
    {
      kind: 'mcp',
      entrypoint: 'mcp:filesystem',
      availabilityCheck: 'mcp-server-configured',
    },
  ],
});

registerCapability({
  id: 'runtime.shell',
  version: 1,
  description: 'Execute a bounded shell command through NanoClaw RTK output filtering.',
  requirements: { toolCalling: 'native-or-bridged', mcp: true, workspace: 'write' },
  sideEffects: 'credentialed',
  approval: 'policy',
  adapters: [
    {
      kind: 'mcp',
      runtimeIds: ['claude-sdk', 'codex-app-server'],
      entrypoint: 'mcp:nanoclaw',
    },
  ],
  mcpTools: ['run_shell'],
});
