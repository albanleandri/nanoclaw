import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { reportAgentTaskProgress, requestAgentTask } from './agent-tasks.js';

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, agent_group_id)
       VALUES ('reviewer', 'Reviewer', 'agent', 'ag-reviewer')`,
    )
    .run();
});
afterEach(closeSessionDb);

describe('durable agent task tools', () => {
  it('resolves only agent destinations and never accepts requester identity', async () => {
    expect(requestAgentTask.tool.inputSchema.properties).not.toHaveProperty('requesterAgentGroupId');
    await expect(requestAgentTask.handler({ to: 'reviewer', goal: 'Review' })).resolves.toHaveProperty('content');
    const row = getOutboundDb().prepare('SELECT content FROM messages_out').get() as { content: string };
    const content = JSON.parse(row.content);
    expect(content).toMatchObject({
      action: 'request_agent_task',
      assigneeAgentGroupId: 'ag-reviewer',
      goal: 'Review',
    });
    expect(content.requesterAgentGroupId).toBeUndefined();
  });

  it('writes typed progress actions for host authorization', async () => {
    await reportAgentTaskProgress.handler({ task_id: 'task-1', message: 'halfway', current: 1, total: 2 });
    const row = getOutboundDb().prepare('SELECT content FROM messages_out').get() as { content: string };
    expect(JSON.parse(row.content)).toMatchObject({
      action: 'report_agent_task_progress',
      taskId: 'task-1',
      message: 'halfway',
    });
  });
});
