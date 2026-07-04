import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import { registerDeliveryAction } from '../delivery.js';
import { appendAgentTaskEvent, getAgentTask, transitionAgentTask, type AgentTaskRecord } from '../db/agent-tasks.js';
import { getDb } from '../db/connection.js';
import { getJobEvent } from '../db/jobs.js';
import { getSession } from '../db/sessions.js';
import { forwardAttachedFiles } from '../modules/agent-to-agent/agent-route.js';
import { isSafeAttachmentName } from '../attachment-safety.js';
import { clearOutbox, sessionDir, wakeContainer, writeSessionMessageIfAbsent } from './agent-task-host-bridge.js';
import type { Session } from '../types.js';
import { requestAgentTask, deliverAgentTaskEvent } from './agent-task-service.js';
import type { AgentTaskEvent } from './agent-task-envelope.js';

function requiredString(content: Record<string, unknown>, key: string): string {
  const value = content[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function taskForActor(taskId: string, actor: Session): AgentTaskRecord {
  const task = getAgentTask(taskId, actor.agent_group_id);
  if (!task) throw new Error(`Agent task not found or unauthorized: ${taskId}`);
  return task;
}

function actorIs(task: AgentTaskRecord, actor: Session, role: 'requester' | 'assignee'): void {
  const expected = role === 'requester' ? task.task.requester_agent_group_id : task.task.assignee_agent_group_id;
  if (actor.agent_group_id !== expected) throw new Error(`Only the task ${role} may perform this action`);
}

function actionWasApplied(taskId: string, actionId: string): boolean {
  return getJobEvent(`agent-task-event:${taskId}:${actionId}`)?.job_id === taskId;
}

async function appendAndDeliver(task: AgentTaskRecord, actionId: string, event: AgentTaskEvent): Promise<void> {
  const appended = appendAgentTaskEvent(task.job.id, actionId, event);
  await deliverAgentTaskEvent(task, appended.data as AgentTaskEvent, appended.seq);
}

registerDeliveryAction('request_agent_task', async (content, session) => {
  await requestAgentTask({
    sourceSession: session,
    envelope: {
      taskId: requiredString(content, 'taskId'),
      requesterAgentGroupId: session.agent_group_id,
      assigneeAgentGroupId: requiredString(content, 'assigneeAgentGroupId'),
      goal: requiredString(content, 'goal'),
      ...(typeof content.context === 'string' && content.context ? { context: content.context } : {}),
      ...(typeof content.parentTaskId === 'string' && content.parentTaskId
        ? { parentTaskId: content.parentTaskId }
        : {}),
      requiredCapabilities: Array.isArray(content.requiredCapabilities)
        ? content.requiredCapabilities.filter((item): item is string => typeof item === 'string')
        : [],
      ...(Array.isArray(content.preferredRuntimeIds)
        ? {
            preferredRuntimeIds: content.preferredRuntimeIds.filter((item): item is string => typeof item === 'string'),
          }
        : {}),
      ...(content.budget && typeof content.budget === 'object' && !Array.isArray(content.budget)
        ? { budget: content.budget as { maxIterations?: number; maxDurationMs?: number; maxCostUsd?: number } }
        : {}),
      artifactPolicy:
        content.artifactPolicy === 'files' || content.artifactPolicy === 'full-trace'
          ? content.artifactPolicy
          : 'summary-only',
      scope: 'agent-delegation',
    },
  });
});

registerDeliveryAction('get_agent_task', async (content, session) => {
  const task = taskForActor(requiredString(content, 'taskId'), session);
  actorIs(task, session, 'requester');
  await appendAndDeliver(task, requiredString(content, 'actionId'), {
    type: 'progress',
    message: `Task status: ${task.job.status}`,
  });
});

registerDeliveryAction('report_agent_task_progress', async (content, session) => {
  const task = taskForActor(requiredString(content, 'taskId'), session);
  actorIs(task, session, 'assignee');
  if (task.job.status !== 'running') throw new Error(`Task is terminal: ${task.job.status}`);
  await appendAndDeliver(task, requiredString(content, 'actionId'), {
    type: 'progress',
    message: requiredString(content, 'message'),
    ...(typeof content.current === 'number' ? { current: content.current } : {}),
    ...(typeof content.total === 'number' ? { total: content.total } : {}),
  });
});

registerDeliveryAction('block_agent_task', async (content, session) => {
  const task = taskForActor(requiredString(content, 'taskId'), session);
  actorIs(task, session, 'assignee');
  if (task.job.status !== 'running') throw new Error(`Task is terminal: ${task.job.status}`);
  await appendAndDeliver(task, requiredString(content, 'actionId'), {
    type: 'blocked',
    reason: requiredString(content, 'reason'),
  });
});

async function terminalAction(
  content: Record<string, unknown>,
  session: Session,
  type: 'completed' | 'failed',
): Promise<void> {
  const taskId = requiredString(content, 'taskId');
  const actionId = requiredString(content, 'actionId');
  const task = taskForActor(taskId, session);
  actorIs(task, session, 'assignee');
  const terminalValue = type === 'completed' ? (content.result ?? null) : requiredString(content, 'error');
  const event: AgentTaskEvent =
    type === 'completed' ? { type, result: content.result ?? null } : { type, error: terminalValue as string };

  // Flip the status and persist the terminal event ATOMICALLY. Previously the
  // transition happened first and the event was appended after, leaving a
  // crash window where the job was terminal with no event row: on retry the
  // CAS failed (no longer 'running') and actionWasApplied was false (event
  // never written), so it threw "Task is terminal" forever and the requester
  // never received the result. With both in one transaction, either the task
  // stays 'running' (retryable) or the event exists as the recovery anchor.
  const persisted = getDb().transaction(() => {
    if (!transitionAgentTask(taskId, ['running'], type === 'completed' ? 'succeeded' : 'failed', terminalValue)) {
      return null;
    }
    return appendAgentTaskEvent(taskId, actionId, event);
  })();

  // Recovery path: the CAS failed because the task is already terminal. If the
  // event was persisted (by this action previously, before delivery), re-fetch
  // it and re-deliver; otherwise this is a genuine late/duplicate action.
  const finalEvent =
    persisted ??
    (actionWasApplied(taskId, actionId)
      ? appendAgentTaskEvent(taskId, actionId, event) // idempotent — returns the existing row
      : null);
  if (!finalEvent) {
    throw new Error(`Task is terminal: ${getAgentTask(taskId)!.job.status}`);
  }

  // Deliver from the persisted event (idempotent — keyed by
  // agent-task-event:<taskId>:<seq>).
  await deliverAgentTaskEvent(getAgentTask(taskId)!, finalEvent.data as AgentTaskEvent, finalEvent.seq);
}

registerDeliveryAction('complete_agent_task', async (content, session) =>
  terminalAction(content, session, 'completed'),
);
registerDeliveryAction('fail_agent_task', async (content, session) => terminalAction(content, session, 'failed'));

registerDeliveryAction('cancel_agent_task', async (content, session) => {
  const taskId = requiredString(content, 'taskId');
  const actionId = requiredString(content, 'actionId');
  let task = taskForActor(taskId, session);
  actorIs(task, session, 'requester');
  if (!transitionAgentTask(taskId, ['queued', 'running'], 'cancelled')) {
    if (actionWasApplied(taskId, actionId)) return;
    throw new Error(`Task is terminal: ${task.job.status}`);
  }
  task = getAgentTask(taskId)!;
  await appendAndDeliver(task, actionId, { type: 'cancelled', message: 'Cancellation requested' });
  if (task.task.assignee_session_id) {
    const target = getSession(task.task.assignee_session_id);
    if (target) {
      writeSessionMessageIfAbsent(target.agent_group_id, target.id, {
        id: task.task.cancel_message_id,
        kind: 'agent-task-cancel',
        timestamp: new Date().toISOString(),
        content: JSON.stringify({ taskId }),
      });
      await wakeContainer(target);
    }
  }
});

registerDeliveryAction(
  'publish_agent_task_artifact',
  async (content: Record<string, unknown>, session: Session, _inDb: Database.Database) => {
    const taskId = requiredString(content, 'taskId');
    const actionId = requiredString(content, 'actionId');
    const task = taskForActor(taskId, session);
    actorIs(task, session, 'assignee');
    if (task.job.status !== 'running') throw new Error(`Task is terminal: ${task.job.status}`);
    if (task.job.params.artifactPolicy === 'summary-only') throw new Error('Task artifact policy forbids files');
    const filename = requiredString(content, 'filename');
    if (!isSafeAttachmentName(filename) || !isSafeAttachmentName(actionId)) throw new Error('Artifact name is unsafe');
    const source = path.join(sessionDir(session.agent_group_id, session.id), 'outbox', actionId, filename);
    const sourceStat = fs.lstatSync(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('Artifact file was missing or unsafe');
    if (sourceStat.size > 25 * 1024 * 1024) throw new Error('Artifact exceeds 25 MiB');
    const sourceBytes = fs.readFileSync(source);
    const targetMessageId = `agent-task-artifact:${taskId}:${actionId}`;
    const attachments = forwardAttachedFiles(
      { agentGroupId: session.agent_group_id, sessionId: session.id, messageId: actionId, filenames: [filename] },
      {
        agentGroupId: task.task.requester_agent_group_id,
        sessionId: task.task.requester_session_id,
        messageId: targetMessageId,
      },
    );
    const attachment = attachments[0];
    if (!attachment) throw new Error('Artifact file was missing or unsafe');
    const absolute = `${sessionDir(task.task.requester_agent_group_id, task.task.requester_session_id)}/${attachment.localPath}`;
    const bytes = fs.readFileSync(absolute);
    await appendAndDeliver(task, actionId, {
      type: 'artifact',
      filename,
      size: bytes.length,
      sha256: createHash('sha256').update(sourceBytes).digest('hex'),
      localPath: attachment.localPath,
    });
    clearOutbox(session.agent_group_id, session.id, actionId);
  },
);
