import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createAgentGroup, closeDb, initTestDb, runMigrations } from '../db/index.js';
import {
  buildStockMarketScreenCommand,
  formatStockMarketScreenFinal,
  formatStockMarketScreenProgress,
} from './stock-market-screen.js';

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

  it('formats progress without exposing internal job ids', () => {
    const message = formatStockMarketScreenProgress({
      id: 'evt-1',
      job_id: 'job-secret',
      seq: 1,
      level: 'progress',
      event_type: 'progress',
      message: 'raw',
      created_at: now(),
      data: {
        current: 100,
        total: 5665,
        batch: 2,
        batches: 114,
        stored: 91,
        failed: 9,
        skipped: 0,
        etaSec: 2820,
      },
    });

    expect(message).toBe('Screen progress: 100/5665 tickers. Batch 2/114. 91 stored, 9 failed. About 47 min left.');
    expect(message).not.toContain('job-secret');
  });

  it('formats cached and suppressed ticker counts separately', () => {
    const message = formatStockMarketScreenProgress({
      id: 'evt-1',
      job_id: 'job-secret',
      seq: 1,
      level: 'progress',
      event_type: 'progress',
      message: 'raw',
      created_at: now(),
      data: {
        current: 250,
        total: 2641,
        batch: 5,
        batches: 53,
        stored: 39,
        failed: 0,
        cached: 10,
        suppressed: 201,
        suppressedByStatus: { data_limited: 150, transient_error: 51 },
      },
    });

    expect(message).toBe(
      'Screen progress: 250/2641 tickers. Batch 5/53. 39 stored, 0 failed, 10 cached, 201 suppressed (150 data-limited, 51 transient errors).',
    );
  });

  it('formats final messages from the worker final event', () => {
    const message = formatStockMarketScreenFinal(
      {
        id: 'job-1',
        type: 'stock_market_screen',
        status: 'succeeded',
        agent_group_id: 'ag-1',
        session_id: null,
        messaging_group_id: null,
        channel_type: null,
        platform_id: null,
        thread_id: null,
        requested_by: null,
        params: {},
        result: null,
        error: null,
        progress_current: 2,
        progress_total: 2,
        started_at: now(),
        finished_at: now(),
        created_at: now(),
        updated_at: now(),
      },
      [
        {
          id: 'evt-1',
          job_id: 'job-1',
          seq: 1,
          level: 'final',
          event_type: 'final',
          message: 'Screen complete: 2/2 stored in 0.1 min.',
          data: null,
          created_at: now(),
        },
      ],
    );

    expect(message).toBe('Screen complete: 2/2 stored in 0.1 min.');
  });
});
