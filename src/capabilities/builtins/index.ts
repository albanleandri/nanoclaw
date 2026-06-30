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
  });
}

registerCapability({
  id: 'nanoclaw.schedule-task',
  version: 1,
  description: 'Schedule a future inbound wake through the host.',
  requirements: { durableState: true },
  sideEffects: 'local-write',
  approval: 'never',
  adapters: [
    { kind: 'host-action', entrypoint: 'host:schedule-task' },
    { kind: 'protocol-tool', runtimeIds: ['openai-protocol-loop'], entrypoint: 'tool:schedule_task' },
  ],
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
