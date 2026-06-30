import type { AgentTaskEnvelope, AgentTaskEvent } from '../jobs/agent-task-envelope.js';
import {
  assertAgentTaskTransition,
  validateAgentTaskEnvelope,
  validateAgentTaskEvent,
} from '../jobs/agent-task-envelope.js';
import { getDb } from './connection.js';
import {
  appendJobEvent,
  createJob,
  getJob,
  getJobEvent,
  type JobEventRecord,
  type JobRecord,
  type JobStatus,
} from './jobs.js';

export interface AgentTaskRow {
  job_id: string;
  requester_agent_group_id: string;
  requester_session_id: string;
  assignee_agent_group_id: string;
  assignee_session_id: string | null;
  parent_task_id: string | null;
  scope: 'agent-delegation' | 'plan-role';
  orchestration_run_id: string | null;
  orchestration_step_id: string | null;
  role_id: string | null;
  dispatch_message_id: string;
  cancel_message_id: string;
}

export interface AgentTaskRecord {
  job: JobRecord<AgentTaskEnvelope>;
  task: AgentTaskRow;
}

function load(id: string): AgentTaskRecord | undefined {
  const job = getJob(id) as JobRecord<AgentTaskEnvelope> | undefined;
  if (!job || job.type !== 'agent_task') return undefined;
  const task = getDb().prepare('SELECT * FROM agent_tasks WHERE job_id = ?').get(id) as AgentTaskRow | undefined;
  return task ? { job, task } : undefined;
}

function sameEnvelope(a: AgentTaskEnvelope, b: AgentTaskEnvelope): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createAgentTask(raw: AgentTaskEnvelope, requesterSessionId: string): AgentTaskRecord {
  const envelope = validateAgentTaskEnvelope(raw);
  const db = getDb();
  return db.transaction(() => {
    const existing = load(envelope.taskId);
    if (existing) {
      if (existing.task.requester_session_id !== requesterSessionId || !sameEnvelope(existing.job.params, envelope)) {
        throw new Error(`Agent task conflict for task id ${envelope.taskId}`);
      }
      return existing;
    }
    createJob({
      id: envelope.taskId,
      type: 'agent_task',
      agentGroupId: envelope.requesterAgentGroupId,
      sessionId: requesterSessionId,
      requestedBy: envelope.requesterAgentGroupId,
      params: envelope,
    });
    db.prepare(
      `INSERT INTO agent_tasks (
        job_id, requester_agent_group_id, requester_session_id,
        assignee_agent_group_id, assignee_session_id, parent_task_id, scope,
        orchestration_run_id, orchestration_step_id, role_id,
        dispatch_message_id, cancel_message_id
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      envelope.taskId,
      envelope.requesterAgentGroupId,
      requesterSessionId,
      envelope.assigneeAgentGroupId,
      envelope.parentTaskId ?? null,
      envelope.scope,
      envelope.scope === 'plan-role' ? envelope.orchestrationRunId : null,
      envelope.scope === 'plan-role' ? envelope.orchestrationStepId : null,
      envelope.scope === 'plan-role' ? envelope.roleId : null,
      `agent-task:${envelope.taskId}`,
      `agent-task-cancel:${envelope.taskId}`,
    );
    return load(envelope.taskId)!;
  })();
}

export function getAgentTask(id: string, actorAgentGroupId?: string): AgentTaskRecord | undefined {
  const task = load(id);
  if (!task || !actorAgentGroupId) return task;
  return task.task.requester_agent_group_id === actorAgentGroupId ||
    task.task.assignee_agent_group_id === actorAgentGroupId
    ? task
    : undefined;
}

export function listAgentTasksForActor(actorAgentGroupId: string, limit = 100): AgentTaskRecord[] {
  const ids = getDb()
    .prepare(
      `SELECT job_id FROM agent_tasks
       WHERE requester_agent_group_id = ? OR assignee_agent_group_id = ?
       ORDER BY rowid DESC LIMIT ?`,
    )
    .all(actorAgentGroupId, actorAgentGroupId, Math.max(1, Math.min(limit, 200))) as Array<{ job_id: string }>;
  return ids.map((row) => load(row.job_id)!);
}

export function setAgentTaskAssigneeSession(id: string, sessionId: string): AgentTaskRecord {
  getDb().prepare('UPDATE agent_tasks SET assignee_session_id = ? WHERE job_id = ?').run(sessionId, id);
  const task = load(id);
  if (!task) throw new Error(`Agent task not found: ${id}`);
  return task;
}

function level(event: AgentTaskEvent): 'info' | 'progress' | 'warning' | 'error' | 'final' {
  if (event.type === 'progress') return 'progress';
  if (event.type === 'blocked') return 'warning';
  if (event.type === 'failed') return 'error';
  if (event.type === 'completed' || event.type === 'cancelled') return 'final';
  return 'info';
}

export function appendAgentTaskEvent(
  id: string,
  actionId: string,
  raw: AgentTaskEvent,
): JobEventRecord<AgentTaskEvent> {
  const event = validateAgentTaskEvent(raw);
  if (!load(id)) throw new Error(`Agent task not found: ${id}`);
  const eventId = `agent-task-event:${id}:${actionId}`;
  const existing = getJobEvent(eventId) as JobEventRecord<AgentTaskEvent> | undefined;
  if (existing) {
    if (JSON.stringify(existing.data) !== JSON.stringify(event))
      throw new Error(`Agent task action conflict: ${actionId}`);
    return existing;
  }
  return appendJobEvent(id, {
    id: eventId,
    level: level(event),
    eventType: event.type,
    message:
      'message' in event
        ? (event.message ?? null)
        : event.type === 'blocked'
          ? event.reason
          : event.type === 'failed'
            ? event.error
            : null,
    data: event,
  }) as JobEventRecord<AgentTaskEvent>;
}

export function transitionAgentTask(id: string, expected: JobStatus[], next: JobStatus, result?: unknown): boolean {
  const db = getDb();
  return db.transaction(() => {
    const current = getJob(id);
    if (!current || current.type !== 'agent_task' || !expected.includes(current.status)) return false;
    assertAgentTaskTransition(current.status, next);
    const placeholders = expected.map(() => '?').join(', ');
    const timestamp = new Date().toISOString();
    const terminal = next === 'succeeded' || next === 'failed' || next === 'cancelled';
    const applied = db
      .prepare(
        `UPDATE jobs SET status = ?, result_json = ?, error = ?, started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
         finished_at = CASE WHEN ? THEN ? ELSE finished_at END, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(
        next,
        next === 'succeeded' && result !== undefined ? JSON.stringify(result) : null,
        next === 'failed' ? String(result ?? 'Agent task failed') : null,
        next,
        timestamp,
        terminal ? 1 : 0,
        timestamp,
        timestamp,
        id,
        ...expected,
      );
    return applied.changes === 1;
  })();
}
