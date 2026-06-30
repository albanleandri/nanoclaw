import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createContainerConfig,
  createSession,
  getAgentTask,
  getJobEvents,
  initTestDb,
  runMigrations,
} from '../db/index.js';
import { createDestination } from '../modules/agent-to-agent/db/agent-destinations.js';
import { inboundDbPath, initSessionFolder } from '../session-manager.js';
import type { Session } from '../types.js';
import { requestAgentTask } from './agent-task-service.js';

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
}));
vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-agent-task-service' };
});

const TEST_DIR = '/tmp/nanoclaw-agent-task-service';
const now = () => new Date().toISOString();
const requester: Session = {
  id: 'sess-requester',
  agent_group_id: 'requester',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: now(),
};
const assigneeSource: Session = {
  ...requester,
  id: 'sess-assignee-source',
  agent_group_id: 'assignee',
};

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  const db = initTestDb();
  runMigrations(db);
  for (const id of ['requester', 'assignee']) {
    createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
    createContainerConfig({
      agent_group_id: id,
      provider: id === 'requester' ? 'claude' : 'codex',
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
      cli_scope: 'group',
      shared_resources: '[]',
      updated_at: now(),
    });
  }
  createSession(requester);
  initSessionFolder(requester.agent_group_id, requester.id);
  createSession(assigneeSource);
  initSessionFolder(assigneeSource.agent_group_id, assigneeSource.id);
  createDestination({
    agent_group_id: 'requester',
    local_name: 'assignee',
    target_type: 'agent',
    target_id: 'assignee',
    created_at: now(),
  });
  createDestination({
    agent_group_id: 'assignee',
    local_name: 'requester',
    target_type: 'agent',
    target_id: 'requester',
    created_at: now(),
  });
});
afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('agent task dispatch', () => {
  it('is retry-safe across central state, target message, events, and requester correlation', async () => {
    const input = {
      sourceSession: requester,
      envelope: {
        taskId: 'task-1',
        requesterAgentGroupId: 'requester',
        assigneeAgentGroupId: 'assignee',
        goal: 'Review',
        requiredCapabilities: ['repo.edit'],
        artifactPolicy: 'summary-only' as const,
        scope: 'agent-delegation' as const,
      },
    };
    const first = await requestAgentTask(input);
    const second = await requestAgentTask(input);
    expect(second.task.assignee_session_id).toBe(first.task.assignee_session_id);
    expect(getAgentTask('task-1')?.job.status).toBe('running');
    expect(getJobEvents('task-1').map((event) => event.event_type)).toEqual(['accepted', 'started']);

    const targetDb = new Database(inboundDbPath('assignee', first.task.assignee_session_id!), { readonly: true });
    expect(targetDb.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE kind = 'agent-task'").get()).toEqual({ n: 1 });
    targetDb.close();
    const requesterDb = new Database(inboundDbPath('requester', requester.id), { readonly: true });
    expect(requesterDb.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE kind = 'agent-task-event'").get()).toEqual({
      n: 2,
    });
    requesterDb.close();
  });

  it('supports Codex-to-Claude delegation and isolates parallel task sessions', async () => {
    const reverse = await requestAgentTask({
      sourceSession: assigneeSource,
      envelope: {
        taskId: 'task-reverse',
        requesterAgentGroupId: 'assignee',
        assigneeAgentGroupId: 'requester',
        goal: 'Review from Codex',
        requiredCapabilities: ['repo.edit'],
        artifactPolicy: 'summary-only',
        scope: 'agent-delegation',
      },
    });
    const parallel = await requestAgentTask({
      sourceSession: assigneeSource,
      envelope: {
        taskId: 'task-parallel',
        requesterAgentGroupId: 'assignee',
        assigneeAgentGroupId: 'requester',
        goal: 'Second review',
        requiredCapabilities: [],
        artifactPolicy: 'summary-only',
        scope: 'agent-delegation',
      },
    });
    expect(reverse.task.assignee_session_id).not.toBe(parallel.task.assignee_session_id);
    expect(reverse.job.status).toBe('running');
    expect(parallel.job.status).toBe('running');
  });
});
