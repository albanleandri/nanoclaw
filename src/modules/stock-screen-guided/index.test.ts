import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResolvePreview, mockStartJob } = vi.hoisted(() => ({
  mockResolvePreview: vi.fn(),
  mockStartJob: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, SCREEN_MARKET_GUIDED_HOST: false };
});

vi.mock('./resolver.js', async () => {
  const actual = await vi.importActual<typeof import('./resolver.js')>('./resolver.js');
  return { ...actual, resolvePreview: (...args: unknown[]) => mockResolvePreview(...args) };
});

vi.mock('../../jobs/runner.js', async () => {
  const actual = await vi.importActual<typeof import('../../jobs/runner.js')>('../../jobs/runner.js');
  return { ...actual, startJob: (...args: unknown[]) => mockStartJob(...args) };
});

import '../../modules/stock-screen-guided/index.js';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { createJob } from '../../db/jobs.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { getResponseHandlers } from '../../response-registry.js';
import { getWizard, recordWizardQuestion, savePreview, saveStepAnswer, startWizard } from './state.js';

const origin = {
  agentGroupId: 'ag-1',
  sessionId: 's-1',
  messagingGroupId: 'mg-1',
  channelType: 'telegram',
  platformId: 'tg-1',
  threadId: null,
  requestedBy: 'u-1',
};

function seedDb(): void {
  const db = initTestDb();
  runMigrations(db);
  db.prepare("INSERT INTO agent_groups (id,name,folder,created_at) VALUES ('ag-1','Agent','telegram_main',?)").run(
    new Date().toISOString(),
  );
  db.prepare(
    "INSERT INTO messaging_groups (id,channel_type,platform_id,is_group,created_at) VALUES ('mg-1','telegram','tg-1',1,?)",
  ).run(new Date().toISOString());
  db.prepare(
    "INSERT INTO sessions (id,agent_group_id,messaging_group_id,created_at) VALUES ('s-1','ag-1','mg-1',?)",
  ).run(new Date().toISOString());
}

async function dispatch(questionId: string, value: string): Promise<boolean> {
  const handler = getResponseHandlers().at(-1);
  if (!handler) throw new Error('missing response handler');
  return handler({ questionId, value, userId: 'u-1', channelType: 'telegram', platformId: 'tg-1', threadId: null });
}

beforeEach(() => {
  seedDb();
  mockResolvePreview.mockReset();
  mockResolvePreview.mockResolvedValue({ total: 2, sample: ['AAPL', 'MSFT'], summary: 'cap: Large Cap' });
  mockStartJob.mockReset();
  mockStartJob.mockImplementation((input) =>
    createJob({
      id: 'job-1',
      type: input.type,
      agentGroupId: input.agentGroupId,
      sessionId: input.sessionId,
      messagingGroupId: input.messagingGroupId,
      channelType: input.channelType,
      platformId: input.platformId,
      threadId: input.threadId,
      requestedBy: input.requestedBy,
      params: input.params,
      status: 'running',
    }),
  );
});

afterEach(() => closeDb());

describe('screen market guided response handler', () => {
  it('saves a step answer and delivers the next deterministic question', async () => {
    const delivered: unknown[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(JSON.parse(content));
        return 'telegram-message-1';
      },
    });
    const wizard = startWizard(origin);
    recordWizardQuestion(wizard.id, 'market_cap', 'q-market-cap');

    await expect(dispatch('q-market-cap', 'Large Cap')).resolves.toBe(true);

    const updated = getWizard(wizard.id);
    expect(updated?.answers.market_cap).toEqual(['Large Cap']);
    expect(updated?.step).toBe('sector');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ type: 'ask_question', title: 'Screen Market', multiple: true });
    expect((delivered[0] as { question: string }).question).toContain('sector');
  });

  it('resolves preview after currency and sends a confirmation question', async () => {
    const delivered: unknown[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(JSON.parse(content));
        return 'telegram-message-2';
      },
    });
    const wizard = startWizard(origin);
    saveStepAnswer(wizard.id, 'market_cap', ['Large Cap']);
    saveStepAnswer(wizard.id, 'sector', []);
    saveStepAnswer(wizard.id, 'geography', ['Canada']);
    recordWizardQuestion(wizard.id, 'currency', 'q-currency');

    await expect(dispatch('q-currency', 'CAD (Canadian Dollar)')).resolves.toBe(true);

    expect(mockResolvePreview).toHaveBeenCalledWith({
      marketCaps: ['Large Cap'],
      countries: ['Canada'],
      currencies: ['CAD'],
    });
    const updated = getWizard(wizard.id);
    expect(updated?.status).toBe('preview');
    expect(updated?.preview?.total).toBe(2);
    expect(delivered[0]).toMatchObject({ type: 'ask_question', multiple: false });
    expect((delivered[0] as { question: string }).question).toContain('Found 2 tickers');
  });

  it('starts the stock screen job from confirmation without waking the agent', async () => {
    const delivered: unknown[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(JSON.parse(content));
        return 'telegram-message-3';
      },
    });
    const wizard = startWizard(origin);
    saveStepAnswer(wizard.id, 'market_cap', ['Large Cap']);
    savePreview(wizard.id, { total: 2, sample: ['AAPL', 'MSFT'], summary: 'cap: Large Cap' });
    recordWizardQuestion(wizard.id, 'confirm', 'q-confirm');

    await expect(dispatch('q-confirm', 'Yes - screen them')).resolves.toBe(true);

    expect(mockStartJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stock_market_screen',
        agentGroupId: 'ag-1',
        sessionId: 's-1',
        messagingGroupId: 'mg-1',
        params: { marketCaps: ['Large Cap'], batchSize: 50, delaySec: 0.5 },
      }),
    );
    const updated = getWizard(wizard.id);
    expect(updated?.status).toBe('started');
    expect(updated?.jobId).toBe('job-1');
    expect(delivered).toEqual([
      { text: 'Screen started. I will send progress here and a final result when it is done.' },
    ]);
  });

  it('does not claim unknown response questions', async () => {
    expect(await dispatch('not-a-screen-market-question', 'Large Cap')).toBe(false);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM screen_market_wizards').get()).toMatchObject({ count: 0 });
  });
});
