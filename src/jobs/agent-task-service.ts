import {
  appendAgentTaskEvent,
  createAgentTask,
  getAgentTask,
  setAgentTaskAssigneeSession,
  transitionAgentTask,
  type AgentTaskRecord,
} from '../db/agent-tasks.js';
import { getSession } from '../db/sessions.js';
import { wakeContainer } from '../container-runner.js';
import { resolveSession, writeSessionMessageIfAbsent } from '../session-manager.js';
import type { Session } from '../types.js';
import { validateAgentTaskEnvelope, type AgentTaskEnvelope, type AgentTaskEvent } from './agent-task-envelope.js';
import { authorizeAgentTask } from './agent-task-policy.js';

const now = () => new Date().toISOString();

export interface RequestAgentTaskInput {
  sourceSession: Session;
  envelope: AgentTaskEnvelope;
}

function eventContent(task: AgentTaskRecord, event: AgentTaskEvent, seq: number): string {
  return JSON.stringify({
    taskId: task.job.id,
    eventSeq: seq,
    event,
    assigneeAgentGroupId: task.task.assignee_agent_group_id,
  });
}

export async function deliverAgentTaskEvent(task: AgentTaskRecord, event: AgentTaskEvent, seq: number): Promise<void> {
  const session = getSession(task.task.requester_session_id);
  if (!session) throw new Error(`Requester session not found: ${task.task.requester_session_id}`);
  writeSessionMessageIfAbsent(session.agent_group_id, session.id, {
    id: `agent-task-event:${task.job.id}:${seq}`,
    kind: 'agent-task-event',
    timestamp: now(),
    content: eventContent(task, event, seq),
  });
  await wakeContainer(session);
}

export async function requestAgentTask(input: RequestAgentTaskInput): Promise<AgentTaskRecord> {
  const envelope = validateAgentTaskEnvelope(input.envelope, {
    requesterAgentGroupId: input.sourceSession.agent_group_id,
  });
  if (envelope.scope !== 'agent-delegation') throw new Error('plan-role dispatch is not implemented');
  authorizeAgentTask({ actorAgentGroupId: input.sourceSession.agent_group_id, envelope });
  let task = createAgentTask(envelope, input.sourceSession.id);
  const accepted = appendAgentTaskEvent(task.job.id, 'accepted', {
    type: 'accepted',
    message: 'Task accepted for dispatch',
  });
  await deliverAgentTaskEvent(task, accepted.data as AgentTaskEvent, accepted.seq);

  let target = task.task.assignee_session_id ? getSession(task.task.assignee_session_id) : undefined;
  if (!target) {
    target = resolveSession(task.task.assignee_agent_group_id, null, task.job.id, 'per-thread').session;
    task = setAgentTaskAssigneeSession(task.job.id, target.id);
  }
  writeSessionMessageIfAbsent(target.agent_group_id, target.id, {
    id: task.task.dispatch_message_id,
    kind: 'agent-task',
    timestamp: now(),
    channelType: 'agent',
    platformId: task.task.requester_agent_group_id,
    content: JSON.stringify(task.job.params),
    sourceSessionId: input.sourceSession.id,
  });
  transitionAgentTask(task.job.id, ['queued'], 'running');
  const started = appendAgentTaskEvent(task.job.id, 'started', {
    type: 'started',
    message: 'Task dispatched to assignee',
  });
  await deliverAgentTaskEvent(task, started.data as AgentTaskEvent, started.seq);
  await wakeContainer(target);
  return getAgentTask(task.job.id)!;
}
