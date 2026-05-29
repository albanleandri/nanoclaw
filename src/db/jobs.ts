import { getDb } from './connection.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type JobEventLevel = 'info' | 'progress' | 'warning' | 'error' | 'final';

export interface JobRecord<TParams = unknown, TResult = unknown> {
  id: string;
  type: string;
  status: JobStatus;
  agent_group_id: string;
  session_id: string | null;
  messaging_group_id: string | null;
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
  requested_by: string | null;
  params: TParams;
  result: TResult | null;
  error: string | null;
  progress_current: number | null;
  progress_total: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobRow {
  id: string;
  type: string;
  status: JobStatus;
  agent_group_id: string;
  session_id: string | null;
  messaging_group_id: string | null;
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
  requested_by: string | null;
  params_json: string;
  result_json: string | null;
  error: string | null;
  progress_current: number | null;
  progress_total: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateJobInput {
  id: string;
  type: string;
  agentGroupId: string;
  params: unknown;
  status?: JobStatus;
  sessionId?: string | null;
  messagingGroupId?: string | null;
  channelType?: string | null;
  platformId?: string | null;
  threadId?: string | null;
  requestedBy?: string | null;
  createdAt?: string;
}

export interface UpdateJobPatch {
  status?: JobStatus;
  result?: unknown | null;
  error?: string | null;
  progressCurrent?: number | null;
  progressTotal?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt?: string;
}

export interface JobEventRecord<TData = unknown> {
  id: string;
  job_id: string;
  seq: number;
  level: JobEventLevel;
  event_type: string;
  message: string | null;
  data: TData | null;
  created_at: string;
}

export interface JobEventRow {
  id: string;
  job_id: string;
  seq: number;
  level: JobEventLevel;
  event_type: string;
  message: string | null;
  data_json: string | null;
  created_at: string;
}

export interface AppendJobEventInput {
  id: string;
  level: JobEventLevel;
  eventType: string;
  message?: string | null;
  data?: unknown | null;
  createdAt?: string;
}

export interface JobEventDelivery {
  job_id: string;
  event_seq: number;
  message_out_id: string | null;
  platform_message_id: string | null;
  delivered_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string | null): T | null {
  if (value === null) return null;
  return JSON.parse(value) as T;
}

function rowToJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    agent_group_id: row.agent_group_id,
    session_id: row.session_id,
    messaging_group_id: row.messaging_group_id,
    channel_type: row.channel_type,
    platform_id: row.platform_id,
    thread_id: row.thread_id,
    requested_by: row.requested_by,
    params: JSON.parse(row.params_json) as unknown,
    result: parseJson(row.result_json),
    error: row.error,
    progress_current: row.progress_current,
    progress_total: row.progress_total,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToEvent(row: JobEventRow): JobEventRecord {
  return {
    id: row.id,
    job_id: row.job_id,
    seq: row.seq,
    level: row.level,
    event_type: row.event_type,
    message: row.message,
    data: parseJson(row.data_json),
    created_at: row.created_at,
  };
}

export function createJob(input: CreateJobInput): JobRecord {
  const timestamp = input.createdAt ?? now();
  getDb()
    .prepare(
      `INSERT INTO jobs (
        id, type, status, agent_group_id, session_id, messaging_group_id,
        channel_type, platform_id, thread_id, requested_by, params_json,
        created_at, updated_at
      ) VALUES (
        @id, @type, @status, @agentGroupId, @sessionId, @messagingGroupId,
        @channelType, @platformId, @threadId, @requestedBy, @paramsJson,
        @createdAt, @updatedAt
      )`,
    )
    .run({
      id: input.id,
      type: input.type,
      status: input.status ?? 'queued',
      agentGroupId: input.agentGroupId,
      sessionId: input.sessionId ?? null,
      messagingGroupId: input.messagingGroupId ?? null,
      channelType: input.channelType ?? null,
      platformId: input.platformId ?? null,
      threadId: input.threadId ?? null,
      requestedBy: input.requestedBy ?? null,
      paramsJson: JSON.stringify(input.params),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  return getJob(input.id)!;
}

export function getJob(id: string): JobRecord | undefined {
  const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  return row ? rowToJob(row) : undefined;
}

export function listRecentJobs(
  filter: { agentGroupId?: string; status?: JobStatus; limit?: number } = {},
): JobRecord[] {
  const limit = Math.max(1, Math.min(filter.limit ?? 20, 200));
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit };
  if (filter.agentGroupId) {
    clauses.push('agent_group_id = @agentGroupId');
    params.agentGroupId = filter.agentGroupId;
  }
  if (filter.status) {
    clauses.push('status = @status');
    params.status = filter.status;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT @limit`)
    .all(params) as JobRow[];
  return rows.map(rowToJob);
}

export function updateJobStatus(id: string, patch: UpdateJobPatch): JobRecord | undefined {
  const fields: string[] = [];
  const params: Record<string, unknown> = { id, updatedAt: patch.updatedAt ?? now() };

  if (patch.status !== undefined) {
    fields.push('status = @status');
    params.status = patch.status;
  }
  if ('result' in patch) {
    fields.push('result_json = @resultJson');
    params.resultJson = patch.result === null ? null : JSON.stringify(patch.result);
  }
  if ('error' in patch) {
    fields.push('error = @error');
    params.error = patch.error ?? null;
  }
  if ('progressCurrent' in patch) {
    fields.push('progress_current = @progressCurrent');
    params.progressCurrent = patch.progressCurrent ?? null;
  }
  if ('progressTotal' in patch) {
    fields.push('progress_total = @progressTotal');
    params.progressTotal = patch.progressTotal ?? null;
  }
  if ('startedAt' in patch) {
    fields.push('started_at = @startedAt');
    params.startedAt = patch.startedAt ?? null;
  }
  if ('finishedAt' in patch) {
    fields.push('finished_at = @finishedAt');
    params.finishedAt = patch.finishedAt ?? null;
  }

  if (fields.length === 0) return getJob(id);
  fields.push('updated_at = @updatedAt');
  getDb()
    .prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = @id`)
    .run(params);
  return getJob(id);
}

export function appendJobEvent(jobId: string, input: AppendJobEventInput): JobEventRecord {
  const db = getDb();
  const createdAt = input.createdAt ?? now();
  const seq = db.transaction(() => {
    const next = (
      db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM job_events WHERE job_id = ?').get(jobId) as {
        seq: number;
      }
    ).seq;
    db.prepare(
      `INSERT INTO job_events (id, job_id, seq, level, event_type, message, data_json, created_at)
       VALUES (@id, @jobId, @seq, @level, @eventType, @message, @dataJson, @createdAt)`,
    ).run({
      id: input.id,
      jobId,
      seq: next,
      level: input.level,
      eventType: input.eventType,
      message: input.message ?? null,
      dataJson: input.data === undefined || input.data === null ? null : JSON.stringify(input.data),
      createdAt,
    });
    db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(createdAt, jobId);
    return next;
  })();
  const row = db.prepare('SELECT * FROM job_events WHERE job_id = ? AND seq = ?').get(jobId, seq) as JobEventRow;
  return rowToEvent(row);
}

export function getJobEvents(jobId: string, opts: { limit?: number; afterSeq?: number } = {}): JobEventRecord[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const rows = getDb()
    .prepare(
      `SELECT * FROM job_events
       WHERE job_id = @jobId AND seq > @afterSeq
       ORDER BY seq ASC
       LIMIT @limit`,
    )
    .all({ jobId, afterSeq: opts.afterSeq ?? 0, limit }) as JobEventRow[];
  return rows.map(rowToEvent);
}

export function markJobEventDelivered(
  jobId: string,
  eventSeq: number,
  ids: { messageOutId?: string | null; platformMessageId?: string | null } = {},
): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO job_deliveries (
        job_id, event_seq, message_out_id, platform_message_id, delivered_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(jobId, eventSeq, ids.messageOutId ?? null, ids.platformMessageId ?? null, now());
}

export function getJobDeliveries(jobId: string): JobEventDelivery[] {
  return getDb()
    .prepare('SELECT * FROM job_deliveries WHERE job_id = ? ORDER BY event_seq ASC')
    .all(jobId) as JobEventDelivery[];
}

export function getUndeliveredJobEvents(jobId: string): JobEventRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT e.* FROM job_events e
       LEFT JOIN job_deliveries d ON d.job_id = e.job_id AND d.event_seq = e.seq
       WHERE e.job_id = ? AND d.job_id IS NULL
       ORDER BY e.seq ASC`,
    )
    .all(jobId) as JobEventRow[];
  return rows.map(rowToEvent);
}
