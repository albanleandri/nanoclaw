/**
 * Delivery action handlers for scheduling.
 *
 * The container can't write to inbound.db (host-owned). When the agent calls
 * schedule_task / cancel_task / etc. via MCP, the container writes a
 * `kind='system'` outbound message with an `action` field. The delivery path
 * reaches into this module via the delivery-action registry and we apply the
 * change to inbound.db here.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';

import { wakeContainer } from '../../container-runner.js';
import { getScheduleAdminGrants, isScheduleAdminAuthorized } from '../../db/schedule-admin-grants.js';
import { findSessionByAgentGroup, getSession, getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { inboundDbPath, openInboundDb, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { cancelTask, insertTask, listLiveTasks, pauseTask, resumeTask, updateTask, type TaskUpdate } from './db.js';

function sessionHasLiveTasks(session: Session): boolean {
  const dbPath = inboundDbPath(session.agent_group_id, session.id);
  if (!fs.existsSync(dbPath)) return false;
  const db = openInboundDb(session.agent_group_id, session.id);
  try {
    const row = db
      .prepare("SELECT 1 FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused') LIMIT 1")
      .get();
    return Boolean(row);
  } finally {
    db.close();
  }
}

function resolveScheduleOwner(session: Session, requestedOwnerId?: string, useGrantDefault = true): Session {
  let ownerAgentGroupId = session.agent_group_id;
  if (requestedOwnerId) {
    if (
      requestedOwnerId !== session.agent_group_id &&
      !isScheduleAdminAuthorized(session.agent_group_id, requestedOwnerId)
    ) {
      throw new Error(`schedule owner not authorized: ${requestedOwnerId}`);
    }
    ownerAgentGroupId = requestedOwnerId;
  } else if (useGrantDefault) {
    const grants = getScheduleAdminGrants(session.agent_group_id);
    if (grants.length === 1) ownerAgentGroupId = grants[0].owner_agent_group_id;
    if (grants.length > 1) throw new Error('multiple schedule owners available; ownerAgentGroupId is required');
  }
  if (ownerAgentGroupId === session.agent_group_id) return session;

  const ownerWithTasks = getSessionsByAgentGroup(ownerAgentGroupId)
    .filter((candidate) => candidate.status === 'active')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .find(sessionHasLiveTasks);
  if (ownerWithTasks) return ownerWithTasks;

  const owner = findSessionByAgentGroup(ownerAgentGroupId);
  if (!owner) throw new Error(`schedule owner session not found: ${ownerAgentGroupId}`);
  return owner;
}

function withScheduleDb<T>(
  session: Session,
  currentDb: Database.Database,
  ownerAgentGroupId: string | undefined,
  fn: (db: Database.Database) => T,
  useGrantDefault = true,
): T {
  const owner = resolveScheduleOwner(session, ownerAgentGroupId, useGrantDefault);
  if (owner.id === session.id) return fn(currentDb);
  const db = openInboundDb(owner.agent_group_id, owner.id);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function writeScheduleAdminResponse(session: Session, requestId: string, payload: Record<string, unknown>): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `schedule-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    trigger: 0,
    content: JSON.stringify({ action: 'schedule_admin_response', requestId, ...payload }),
  });
}

export async function handleListTasks(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = content.requestId as string;
  const status = typeof content.status === 'string' ? content.status : undefined;
  const ownerId = typeof content.ownerAgentGroupId === 'string' ? content.ownerAgentGroupId : undefined;
  const rows = withScheduleDb(session, inDb, ownerId, (db) => listLiveTasks(db, status));
  writeScheduleAdminResponse(session, requestId, { ok: true, tasks: rows });
}

export async function handleScheduleTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const prompt = content.prompt as string;
  const script = content.script as string | null;
  const processAfter = content.processAfter as string;
  const recurrence = (content.recurrence as string) || null;

  const ownerId = typeof content.ownerAgentGroupId === 'string' ? content.ownerAgentGroupId : undefined;
  withScheduleDb(
    _session,
    inDb,
    ownerId,
    (db) =>
      insertTask(db, {
        id: taskId,
        processAfter,
        recurrence,
        platformId: (content.platformId as string) ?? null,
        channelType: (content.channelType as string) ?? null,
        threadId: (content.threadId as string) ?? null,
        content: JSON.stringify({ prompt, script }),
      }),
    false,
  );
  log.info('Scheduled task created', { taskId, processAfter, recurrence });
}

export async function handleCancelTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  withScheduleDb(_session, inDb, content.ownerAgentGroupId as string | undefined, (db) => cancelTask(db, taskId));
  log.info('Task cancelled', { taskId });
}

export async function handlePauseTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  withScheduleDb(_session, inDb, content.ownerAgentGroupId as string | undefined, (db) => pauseTask(db, taskId));
  log.info('Task paused', { taskId });
}

export async function handleResumeTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  withScheduleDb(_session, inDb, content.ownerAgentGroupId as string | undefined, (db) => resumeTask(db, taskId));
  log.info('Task resumed', { taskId });
}

export async function handleUpdateTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const update: TaskUpdate = {};
  if (typeof content.prompt === 'string') update.prompt = content.prompt;
  if (typeof content.processAfter === 'string') update.processAfter = content.processAfter;
  if (content.recurrence === null || typeof content.recurrence === 'string') {
    update.recurrence = content.recurrence as string | null;
  }
  if (content.script === null || typeof content.script === 'string') {
    update.script = content.script as string | null;
  }
  const touched = withScheduleDb(session, inDb, content.ownerAgentGroupId as string | undefined, (db) =>
    updateTask(db, taskId, update),
  );
  log.info('Task updated', { taskId, touched, fields: Object.keys(update) });
  if (touched === 0) {
    // Notify the agent that update_task matched nothing. Replicates the
    // old notifyAgent helper that used to live in delivery.ts — inlined
    // here so scheduling doesn't depend on delivery's private helpers.
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `update_task: no live task matched id "${taskId}".`,
        sender: 'system',
        senderId: 'system',
      }),
    });
    const fresh = getSession(session.id);
    if (fresh) {
      wakeContainer(fresh).catch((err) =>
        log.error('Failed to wake container after update_task notification', { err }),
      );
    }
  }
}
