import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createContainerConfig,
  createSession,
  initTestDb,
  runMigrations,
} from '../db/index.js';
import { createDestination } from '../modules/agent-to-agent/db/agent-destinations.js';
import type { AgentTaskEnvelope } from './agent-task-envelope.js';
import { authorizeAgentTask } from './agent-task-policy.js';

const now = () => new Date().toISOString();
const envelope: AgentTaskEnvelope = {
  taskId: 'task-1',
  requesterAgentGroupId: 'requester',
  assigneeAgentGroupId: 'assignee',
  goal: 'Review',
  requiredCapabilities: ['repo.edit'],
  artifactPolicy: 'summary-only',
  scope: 'agent-delegation',
};

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  for (const [id, scope] of [
    ['requester', 'global'],
    ['assignee', 'disabled'],
  ] as const) {
    createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
    createContainerConfig({
      agent_group_id: id,
      provider: id === 'assignee' ? 'codex' : 'claude',
      model: null,
      effort: null,
      image_tag: null,
      assistant_name: id,
      max_messages_per_prompt: null,
      skills: '[]',
      mcp_servers: '{}',
      packages_apt: '[]',
      packages_npm: '[]',
      additional_mounts: '[]',
      cli_scope: scope,
      shared_resources: '[]',
      updated_at: now(),
    });
    createSession({
      id: `sess-${id}`,
      agent_group_id: id,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
  }
});
afterEach(closeDb);

describe('agent task admission policy', () => {
  it('requires an explicit agent destination', () => {
    expect(() => authorizeAgentTask({ actorAgentGroupId: 'requester', envelope })).toThrow(/destination/);
  });

  it('compiles required capabilities under the assignee policy without inheriting requester scope', () => {
    createDestination({
      agent_group_id: 'requester',
      local_name: 'assignee',
      target_type: 'agent',
      target_id: 'assignee',
      created_at: now(),
    });
    const admitted = authorizeAgentTask({ actorAgentGroupId: 'requester', envelope });
    expect(admitted.runtime.runtimeId).toBe('codex-app-server');
    expect(admitted.plan.policy.cliScope).toBe('disabled');
    expect(admitted.plan.capabilities.map((item) => item.id)).toContain('repo.edit');
    expect(JSON.stringify(admitted)).not.toContain('global');
  });

  it('fails before dispatch for unknown/incompatible capabilities but treats runtime preferences as non-authoritative', () => {
    createDestination({
      agent_group_id: 'requester',
      local_name: 'assignee',
      target_type: 'agent',
      target_id: 'assignee',
      created_at: now(),
    });
    expect(() =>
      authorizeAgentTask({
        actorAgentGroupId: 'requester',
        envelope: { ...envelope, requiredCapabilities: ['missing.x'] },
      }),
    ).toThrow(/Unknown capability/);
    expect(() =>
      authorizeAgentTask({
        actorAgentGroupId: 'requester',
        envelope: { ...envelope, requiredCapabilities: ['web.browse'] },
      }),
    ).toThrow(/web.browse/);
    expect(
      authorizeAgentTask({
        actorAgentGroupId: 'requester',
        envelope: { ...envelope, preferredRuntimeIds: ['claude-sdk'] },
      }).preferredRuntimeMatched,
    ).toBe(false);
  });
});
