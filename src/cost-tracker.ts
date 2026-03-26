import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';

import { GROUPS_DIR, TIMEZONE } from './config.js';
import {
  createTask,
  getAllRegisteredGroups,
  getDb,
  getTaskById,
} from './db.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Pricing table — USD per 1 000 000 tokens
// ---------------------------------------------------------------------------
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
const DEFAULT_PRICING = { input: 3, output: 15 }; // Sonnet rates

// ---------------------------------------------------------------------------
// Well-known task IDs for the three cost-report schedules
// ---------------------------------------------------------------------------
export const DAILY_COST_TASK_ID = 'nanoclaw-cost-daily';
export const WEEKLY_COST_TASK_ID = 'nanoclaw-cost-weekly';
export const MONTHLY_COST_TASK_ID = 'nanoclaw-cost-monthly';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
export function ensureCostTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_ledger (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at        TEXT    NOT NULL,
      group_folder  TEXT    NOT NULL,
      model         TEXT    NOT NULL,
      input_tokens  INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd      REAL    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cost_ledger_run_at
      ON cost_ledger(run_at);
    CREATE INDEX IF NOT EXISTS idx_cost_ledger_group
      ON cost_ledger(group_folder);

    CREATE TABLE IF NOT EXISTS cost_totals (
      period       TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      total_usd    REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (period, group_folder)
    );
  `);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function lookupPricing(model: string): { input: number; output: number } {
  const key = Object.keys(PRICING).find((k) => model.toLowerCase().includes(k));
  return key ? PRICING[key] : DEFAULT_PRICING;
}

function periodKeys(date: Date): {
  daily: string;
  weekly: string;
  monthly: string;
} {
  const iso = date.toISOString();
  const daily = `daily:${iso.slice(0, 10)}`;
  const monthly = `monthly:${iso.slice(0, 7)}`;

  // ISO week number (Monday = week start)
  const day = date.getDay() || 7;
  const thursday = new Date(date);
  thursday.setDate(date.getDate() - day + 4);
  const yearStart = new Date(thursday.getFullYear(), 0, 1);
  const weekNum = Math.ceil(
    ((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  const weekly = `weekly:${thursday.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;

  return { daily, weekly, monthly };
}

// ---------------------------------------------------------------------------
// Report builders
// ---------------------------------------------------------------------------
export function buildDailyReport(db: Database.Database, date?: Date): string {
  const d = (date ?? new Date()).toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT group_folder,
              SUM(cost_usd)      AS total,
              SUM(input_tokens)  AS inp,
              SUM(output_tokens) AS out,
              COUNT(*)           AS runs
       FROM cost_ledger
       WHERE run_at LIKE ?
       GROUP BY group_folder
       ORDER BY total DESC`,
    )
    .all(`${d}%`) as Array<{
    group_folder: string;
    total: number;
    inp: number;
    out: number;
    runs: number;
  }>;

  if (rows.length === 0)
    return `*Daily cost report — ${d}*\nNo agent runs today.`;
  const grand = rows.reduce((s, r) => s + r.total, 0);
  const lines = rows.map(
    (r) => `• ${r.group_folder}: $${r.total.toFixed(4)} (${r.runs} runs)`,
  );
  return `*Daily cost report — ${d}*\nTotal: $${grand.toFixed(4)}\n${lines.join('\n')}`;
}

export function buildWeeklyReport(db: Database.Database, date?: Date): string {
  const ref = date ?? new Date();
  const day = ref.getDay() || 7;
  const monday = new Date(ref);
  monday.setDate(ref.getDate() - day + 1);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  const rows = db
    .prepare(
      `SELECT group_folder, SUM(cost_usd) AS total, COUNT(*) AS runs
       FROM cost_ledger
       WHERE run_at >= ? AND run_at <= ?
       GROUP BY group_folder
       ORDER BY total DESC`,
    )
    .all(monday.toISOString(), sunday.toISOString()) as Array<{
    group_folder: string;
    total: number;
    runs: number;
  }>;

  const span = `${monday.toISOString().slice(0, 10)} – ${sunday.toISOString().slice(0, 10)}`;
  if (rows.length === 0)
    return `*Weekly cost report — ${span}*\nNo agent runs this week.`;
  const grand = rows.reduce((s, r) => s + r.total, 0);
  const lines = rows.map(
    (r) => `• ${r.group_folder}: $${r.total.toFixed(4)} (${r.runs} runs)`,
  );
  return `*Weekly cost report — ${span}*\nTotal: $${grand.toFixed(4)}\n${lines.join('\n')}`;
}

export function buildMonthlyReport(db: Database.Database, date?: Date): string {
  const month = (date ?? new Date()).toISOString().slice(0, 7);
  const rows = db
    .prepare(
      `SELECT group_folder, SUM(cost_usd) AS total, COUNT(*) AS runs
       FROM cost_ledger
       WHERE run_at LIKE ?
       GROUP BY group_folder
       ORDER BY total DESC`,
    )
    .all(`${month}%`) as Array<{
    group_folder: string;
    total: number;
    runs: number;
  }>;

  if (rows.length === 0)
    return `*Monthly cost report — ${month}*\nNo agent runs this month.`;
  const grand = rows.reduce((s, r) => s + r.total, 0);
  const lines = rows.map(
    (r) => `• ${r.group_folder}: $${r.total.toFixed(4)} (${r.runs} runs)`,
  );
  return `*Monthly cost report — ${month}*\nTotal: $${grand.toFixed(4)}\n${lines.join('\n')}`;
}

// Write current daily/weekly/monthly reports to the main group's workspace
// so scheduled agent tasks (and on-demand queries) can read them.
function writeReportFiles(mainGroupFolder: string): void {
  const db = getDb();
  const dir = path.join(GROUPS_DIR, mainGroupFolder);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cost_daily.txt'), buildDailyReport(db));
    fs.writeFileSync(path.join(dir, 'cost_weekly.txt'), buildWeeklyReport(db));
    fs.writeFileSync(
      path.join(dir, 'cost_monthly.txt'),
      buildMonthlyReport(db),
    );
  } catch (err) {
    logger.warn({ err, mainGroupFolder }, 'Failed to write cost report files');
  }
}

// ---------------------------------------------------------------------------
// Record cost — silent, no receipt sent to chat
// ---------------------------------------------------------------------------
export function recordCost(
  groupFolder: string,
  model: string,
  realInputTokens?: number,
  realOutputTokens?: number,
  realCostUsd?: number,
): void {
  const db = getDb();
  const inputTokens = realInputTokens ?? 0;
  const outputTokens = realOutputTokens ?? 0;
  const pricing = lookupPricing(model);
  const costUsd =
    realCostUsd ??
    (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  const runAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO cost_ledger (run_at, group_folder, model, input_tokens, output_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(runAt, groupFolder, model, inputTokens, outputTokens, costUsd);

  const periods = periodKeys(new Date(runAt));
  const upsert = db.prepare(
    `INSERT INTO cost_totals (period, group_folder, total_usd) VALUES (?, ?, ?)
     ON CONFLICT(period, group_folder) DO UPDATE SET total_usd = total_usd + excluded.total_usd`,
  );
  upsert.run(periods.daily, groupFolder, costUsd);
  upsert.run(periods.weekly, groupFolder, costUsd);
  upsert.run(periods.monthly, groupFolder, costUsd);

  logger.info(
    { groupFolder, model, inputTokens, outputTokens, costUsd },
    'Cost recorded',
  );

  // Keep report files fresh so the agent can answer cost queries at any time.
  const groups = getAllRegisteredGroups();
  const mainFolder = Object.values(groups).find((g) => g.isMain)?.folder;
  if (mainFolder) writeReportFiles(mainFolder);
}

// ---------------------------------------------------------------------------
// Task registration — called once at startup
// ---------------------------------------------------------------------------
export function registerCostTasks(): void {
  const db = getDb();
  const groups = getAllRegisteredGroups();
  const mainEntry = Object.entries(groups).find(([, g]) => g.isMain);
  if (!mainEntry) {
    logger.debug('No main group found — skipping cost task registration');
    return;
  }
  const [mainJid, mainGroup] = mainEntry;
  const now = new Date().toISOString();

  const tasks = [
    {
      id: DAILY_COST_TASK_ID,
      prompt:
        'Read the file cost_daily.txt from your workspace (/workspace/group/cost_daily.txt) and send its contents to the user as-is.',
      // TODO: set your preferred daily report time, e.g. "0 20 * * *"
      schedule_value: '0 20 * * *',
    },
    {
      id: WEEKLY_COST_TASK_ID,
      prompt:
        'Read the file cost_weekly.txt from your workspace (/workspace/group/cost_weekly.txt) and send its contents to the user as-is.',
      // TODO: set your preferred weekly report time (Mondays), e.g. "0 20 * * 1"
      schedule_value: '0 20 * * 1',
    },
    {
      id: MONTHLY_COST_TASK_ID,
      prompt:
        'Read the file cost_monthly.txt from your workspace (/workspace/group/cost_monthly.txt) and send its contents to the user as-is.',
      // TODO: set your preferred monthly report time (1st of month), e.g. "0 20 1 * *"
      schedule_value: '0 20 1 * *',
    },
  ];

  for (const t of tasks) {
    if (getTaskById(t.id)) continue; // already registered

    const nextRun = CronExpressionParser.parse(t.schedule_value, {
      tz: TIMEZONE,
    })
      .next()
      .toISOString();

    createTask({
      id: t.id,
      group_folder: mainGroup.folder,
      chat_jid: mainJid,
      prompt: t.prompt,
      schedule_type: 'cron',
      schedule_value: t.schedule_value,
      context_mode: 'isolated',
      next_run: nextRun,
      status: 'active',
      created_at: now,
    });
    logger.info(
      { taskId: t.id, schedule: t.schedule_value },
      'Cost report task registered',
    );
  }
}
