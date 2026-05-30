import { execFile } from 'child_process';
import { promisify } from 'util';

import type { StockMarketScreenParams } from '../../jobs/stock-market-screen.js';
import type { WizardPreview } from './state.js';

const execFileAsync = promisify(execFile);
const SCRIPT = 'container/skills/custom/stock-market-investing/market_tickers.py';

export function buildPreviewArgs(params: StockMarketScreenParams): string[] {
  const args = [SCRIPT];
  if (params.marketCaps?.length) args.push('--market-cap', ...params.marketCaps);
  if (params.sectors?.length) args.push('--sector', ...params.sectors);
  if (params.countries?.length) args.push('--countries', ...params.countries);
  if (params.exchanges?.length) args.push('--exchanges', ...params.exchanges);
  if (params.currencies?.length) args.push('--currency', ...params.currencies);
  args.push('--preview', '5');
  return args;
}

export function summarizeParams(params: StockMarketScreenParams): string {
  const parts = [
    params.marketCaps?.length ? `cap: ${params.marketCaps.join(', ')}` : null,
    params.sectors?.length ? `sector: ${params.sectors.join(', ')}` : null,
    params.countries?.length ? `countries: ${params.countries.join(', ')}` : null,
    params.exchanges?.length ? `exchanges: ${params.exchanges.join(', ')}` : null,
    params.currencies?.length ? `currency: ${params.currencies.join(', ')}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' | ') : 'All markets, sectors, currencies, and cap tiers';
}

export async function resolvePreview(params: StockMarketScreenParams): Promise<WizardPreview> {
  const { stdout } = await execFileAsync('python3', buildPreviewArgs(params), {
    cwd: process.cwd(),
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  const lines = stdout.trim().split(/\r?\n/);
  const total = Number.parseInt(lines[0] ?? '', 10);
  if (!Number.isFinite(total)) throw new Error('market_tickers.py returned malformed preview count');
  if (total === 0) throw new Error('No tickers found for those filters');
  const sample = (lines[1] ?? '').split(/\s+/).filter(Boolean).slice(0, 5);
  return { total, sample, summary: summarizeParams(params) };
}
