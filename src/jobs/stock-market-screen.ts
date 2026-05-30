import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { registerJobType } from './registry.js';
import type { JobEventRecord, JobRecord } from '../db/jobs.js';
import type { JobContext, JobCommand } from './types.js';

export interface StockMarketScreenParams {
  marketCaps?: string[];
  sectors?: string[];
  countries?: string[];
  exchanges?: string[];
  currencies?: string[];
  tickers?: string[];
  batchSize?: number;
  delaySec?: number;
  maxAgeHours?: number;
  limit?: number;
}

function stringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value.filter((v) => v.trim()).map((v) => v.trim());
}

function numberValue(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function addRepeated(args: string[], flag: string, values: string[] | undefined): void {
  if (values && values.length > 0) args.push(flag, ...values);
}

function numberFromData(data: unknown, key: string): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatEta(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) return '';
  const minutes = Math.max(1, Math.round(seconds / 60));
  return ` About ${minutes} min left.`;
}

export function formatStockMarketScreenProgress(event: JobEventRecord): string | null {
  const data = event.data;
  const current = numberFromData(data, 'current');
  const total = numberFromData(data, 'total');
  const batch = numberFromData(data, 'batch');
  const batches = numberFromData(data, 'batches');
  const stored = numberFromData(data, 'stored');
  const failed = numberFromData(data, 'failed');
  const cached = numberFromData(data, 'cached') ?? numberFromData(data, 'skipped');
  const suppressed = numberFromData(data, 'suppressed');
  const etaSec = numberFromData(data, 'etaSec');
  if (current === undefined || total === undefined) return event.message;

  const batchText = batch !== undefined && batches !== undefined ? ` Batch ${batch}/${batches}.` : '';
  const resultParts = [
    stored !== undefined ? `${stored} stored` : null,
    failed !== undefined ? `${failed} failed` : null,
    cached !== undefined && cached > 0 ? `${cached} cached` : null,
    suppressed !== undefined && suppressed > 0 ? `${suppressed} suppressed` : null,
  ].filter(Boolean);
  const resultText = resultParts.length ? ` ${resultParts.join(', ')}.` : '';
  return `Screen progress: ${current}/${total} tickers.${batchText}${resultText}${formatEta(etaSec)}`;
}

export function formatStockMarketScreenFinal(job: JobRecord, events: JobEventRecord[]): string {
  const finalEvent = [...events].reverse().find((event) => event.level === 'final');
  if (finalEvent?.message) return finalEvent.message;
  const total = job.progress_total ?? job.progress_current ?? '?';
  return `Screen complete: ${total}/${total} tickers processed.`;
}

function validateParams(params: unknown): StockMarketScreenParams {
  const p = (params ?? {}) as Record<string, unknown>;
  const out: StockMarketScreenParams = {
    marketCaps: stringArray(p.marketCaps ?? p.market_caps, 'marketCaps'),
    sectors: stringArray(p.sectors, 'sectors'),
    countries: stringArray(p.countries, 'countries'),
    exchanges: stringArray(p.exchanges, 'exchanges'),
    currencies: stringArray(p.currencies ?? p.currency, 'currencies'),
    tickers: stringArray(p.tickers, 'tickers'),
    batchSize: numberValue(p.batchSize ?? p.batch_size, 'batchSize'),
    delaySec: numberValue(p.delaySec ?? p.delay_sec, 'delaySec'),
    maxAgeHours: numberValue(p.maxAgeHours ?? p.max_age_hours, 'maxAgeHours'),
    limit: numberValue(p.limit, 'limit'),
  };
  if (out.batchSize !== undefined && (!Number.isInteger(out.batchSize) || out.batchSize < 1 || out.batchSize > 500)) {
    throw new Error('batchSize must be an integer between 1 and 500');
  }
  if (out.limit !== undefined && (!Number.isInteger(out.limit) || out.limit < 1))
    throw new Error('limit must be a positive integer');
  if (out.delaySec !== undefined && out.delaySec < 0) throw new Error('delaySec must be non-negative');
  if (out.maxAgeHours !== undefined && out.maxAgeHours < 0) throw new Error('maxAgeHours must be non-negative');
  return out;
}

export function buildStockMarketScreenCommand(ctx: JobContext, params: StockMarketScreenParams): JobCommand {
  const group = getAgentGroup(ctx.agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${ctx.agentGroupId}`);

  const script = path.resolve('container/skills/custom/stock-market-investing/market_screen_job.py');
  const db = path.join(GROUPS_DIR, group.folder, 'investments.db');
  const args = [script, '--db', db, '--job-id', ctx.jobId];

  addRepeated(args, '--market-cap', params.marketCaps);
  addRepeated(args, '--sector', params.sectors);
  addRepeated(args, '--countries', params.countries);
  addRepeated(args, '--exchanges', params.exchanges);
  addRepeated(args, '--currency', params.currencies);
  addRepeated(args, '--tickers', params.tickers);
  if (params.batchSize !== undefined) args.push('--batch-size', String(params.batchSize));
  if (params.delaySec !== undefined) args.push('--delay', String(params.delaySec));
  if (params.maxAgeHours !== undefined) args.push('--max-age-hours', String(params.maxAgeHours));
  if (params.limit !== undefined) args.push('--limit', String(params.limit));

  return { command: 'python3', args, cwd: process.cwd() };
}

registerJobType<StockMarketScreenParams>({
  type: 'stock_market_screen',
  validateParams,
  buildCommand: buildStockMarketScreenCommand,
  formatProgress: formatStockMarketScreenProgress,
  formatFinal: formatStockMarketScreenFinal,
});
