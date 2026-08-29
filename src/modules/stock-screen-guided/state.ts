import { getDb } from '../../db/connection.js';
import type { WizardAnswers, WizardStep } from './options.js';

export type WizardStatus = 'active' | 'preview' | 'started' | 'cancelled' | 'expired' | 'failed';

export interface WizardOrigin {
  agentGroupId: string;
  sessionId: string;
  messagingGroupId: string | null;
  channelType: string;
  platformId: string;
  threadId: string | null;
  requestedBy: string | null;
}

export interface WizardPreview {
  total: number;
  sample: string[];
  summary: string;
}

export interface ScreenMarketWizard extends WizardOrigin {
  id: string;
  status: WizardStatus;
  step: WizardStep;
  answers: WizardAnswers;
  preview: WizardPreview | null;
  jobId: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface WizardQuestionRef {
  questionId: string;
  wizardId: string;
  step: WizardStep;
  createdAt: string;
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function expiresAtIso(now = new Date(), minutes = 30): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

function parseWizard(row: Record<string, unknown>): ScreenMarketWizard {
  return {
    id: row.id as string,
    status: row.status as WizardStatus,
    step: row.step as WizardStep,
    agentGroupId: row.agent_group_id as string,
    sessionId: row.session_id as string,
    messagingGroupId: (row.messaging_group_id as string | null) ?? null,
    channelType: row.channel_type as string,
    platformId: row.platform_id as string,
    threadId: (row.thread_id as string | null) ?? null,
    requestedBy: (row.requested_by as string | null) ?? null,
    answers: JSON.parse((row.answers_json as string | null) ?? '{}') as WizardAnswers,
    preview: row.preview_json ? (JSON.parse(row.preview_json as string) as WizardPreview) : null,
    jobId: (row.job_id as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    expiresAt: row.expires_at as string,
  };
}

export function startWizard(origin: WizardOrigin, now = nowIso()): ScreenMarketWizard {
  const db = getDb();
  db.prepare(
    `UPDATE screen_market_wizards
     SET status = 'cancelled', updated_at = ?
     WHERE channel_type = ? AND platform_id = ? AND COALESCE(thread_id, '') = COALESCE(?, '')
       AND status IN ('active', 'preview')`,
  ).run(now, origin.channelType, origin.platformId, origin.threadId);

  const id = generateId('smw');
  db.prepare(
    `INSERT INTO screen_market_wizards
      (id, status, step, agent_group_id, session_id, messaging_group_id, channel_type, platform_id, thread_id,
       requested_by, answers_json, created_at, updated_at, expires_at)
     VALUES (?, 'active', 'market_cap', ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
  ).run(
    id,
    origin.agentGroupId,
    origin.sessionId,
    origin.messagingGroupId,
    origin.channelType,
    origin.platformId,
    origin.threadId,
    origin.requestedBy,
    now,
    now,
    expiresAtIso(new Date(now)),
  );
  return getWizard(id)!;
}

export function getWizard(id: string): ScreenMarketWizard | undefined {
  const row = getDb().prepare('SELECT * FROM screen_market_wizards WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? parseWizard(row) : undefined;
}

export function recordWizardQuestion(wizardId: string, step: WizardStep, questionId: string, now = nowIso()): void {
  const db = getDb();
  db.prepare('DELETE FROM screen_market_wizard_questions WHERE wizard_id = ? AND step = ?').run(wizardId, step);
  db.prepare(
    'INSERT INTO screen_market_wizard_questions (question_id, wizard_id, step, created_at) VALUES (?, ?, ?, ?)',
  ).run(questionId, wizardId, step, now);
}

export function getWizardQuestion(questionId: string): WizardQuestionRef | undefined {
  const row = getDb().prepare('SELECT * FROM screen_market_wizard_questions WHERE question_id = ?').get(questionId) as
    { question_id: string; wizard_id: string; step: WizardStep; created_at: string } | undefined;
  return row
    ? { questionId: row.question_id, wizardId: row.wizard_id, step: row.step, createdAt: row.created_at }
    : undefined;
}

export function saveStepAnswer(
  wizardId: string,
  step: WizardStep,
  selectedLabels: string[],
  now = nowIso(),
): ScreenMarketWizard {
  const wizard = getWizard(wizardId);
  if (!wizard) throw new Error(`Wizard not found: ${wizardId}`);
  const answers = { ...wizard.answers, [step]: selectedLabels };
  getDb()
    .prepare('UPDATE screen_market_wizards SET answers_json = ?, updated_at = ?, expires_at = ? WHERE id = ?')
    .run(JSON.stringify(answers), now, expiresAtIso(new Date(now)), wizardId);
  return getWizard(wizardId)!;
}

export function advanceWizard(
  wizardId: string,
  step: WizardStep,
  status: WizardStatus = 'active',
  now = nowIso(),
): ScreenMarketWizard {
  getDb()
    .prepare('UPDATE screen_market_wizards SET step = ?, status = ?, updated_at = ?, expires_at = ? WHERE id = ?')
    .run(step, status, now, expiresAtIso(new Date(now)), wizardId);
  return getWizard(wizardId)!;
}

export function savePreview(wizardId: string, preview: WizardPreview, now = nowIso()): ScreenMarketWizard {
  getDb()
    .prepare(
      "UPDATE screen_market_wizards SET status = 'preview', step = 'confirm', preview_json = ?, updated_at = ?, expires_at = ? WHERE id = ?",
    )
    .run(JSON.stringify(preview), now, expiresAtIso(new Date(now)), wizardId);
  return getWizard(wizardId)!;
}

export function markWizardStarted(wizardId: string, jobId: string, now = nowIso()): ScreenMarketWizard {
  getDb()
    .prepare("UPDATE screen_market_wizards SET status = 'started', job_id = ?, updated_at = ? WHERE id = ?")
    .run(jobId, now, wizardId);
  return getWizard(wizardId)!;
}

export function markWizardFailed(wizardId: string, now = nowIso()): void {
  getDb().prepare("UPDATE screen_market_wizards SET status = 'failed', updated_at = ? WHERE id = ?").run(now, wizardId);
}

export function cancelWizard(wizardId: string, now = nowIso()): void {
  getDb()
    .prepare("UPDATE screen_market_wizards SET status = 'cancelled', updated_at = ? WHERE id = ?")
    .run(now, wizardId);
}

export function expireWizard(wizardId: string, now = nowIso()): void {
  getDb()
    .prepare("UPDATE screen_market_wizards SET status = 'expired', updated_at = ? WHERE id = ?")
    .run(now, wizardId);
}

export function expireOldWizards(now = nowIso()): number {
  const result = getDb()
    .prepare(
      "UPDATE screen_market_wizards SET status = 'expired', updated_at = ? WHERE status IN ('active', 'preview') AND expires_at <= ?",
    )
    .run(now, now);
  return result.changes;
}
