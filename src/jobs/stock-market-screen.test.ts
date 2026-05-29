import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createAgentGroup, closeDb, initTestDb, runMigrations } from '../db/index.js';
import { buildStockMarketScreenCommand } from './stock-market-screen.js';

function now() {
  return new Date().toISOString();
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'telegram_main', agent_provider: null, created_at: now() });
});

afterEach(() => closeDb());

describe('stock_market_screen job type', () => {
  it('builds a command scoped to the agent group investment DB', () => {
    const command = buildStockMarketScreenCommand(
      { jobId: 'job-1', agentGroupId: 'ag-1' },
      {
        marketCaps: ['Mega Cap', 'Large Cap'],
        exchanges: ['nasdaq', 'nyse'],
        currencies: ['USD'],
        batchSize: 25,
        delaySec: 0.1,
        maxAgeHours: 12,
        limit: 100,
      },
    );

    expect(command.command).toBe('python3');
    expect(command.args[0]).toContain('container/skills/custom/stock-market-investing/market_screen_job.py');
    expect(command.args.some((arg) => arg.includes('groups/telegram_main/investments.db'))).toBe(true);
    expect(command.args).toContain('--market-cap');
    expect(command.args).toContain('Mega Cap');
    expect(command.args).toContain('--exchanges');
    expect(command.args).toContain('nasdaq');
    expect(command.args).toContain('--limit');
    expect(command.args).toContain('100');
  });
});
