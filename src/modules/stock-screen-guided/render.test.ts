import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getAskQuestionRender } from '../../db/sessions.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { getQuestion } from './options.js';
import { buildPreviewQuestion, buildQuestionPayload, deliverQuestion } from './render.js';
import { startWizard } from './state.js';

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

beforeEach(seedDb);
afterEach(() => closeDb());

describe('screen market guided question rendering', () => {
  it('builds deterministic ask_question payloads', () => {
    const payload = buildQuestionPayload(getQuestion('currency'), 'q-1');
    expect(payload).toMatchObject({
      type: 'ask_question',
      questionId: 'q-1',
      title: 'Screen Market',
      multiple: true,
    });
    expect(payload.options).toContain('All currencies');
  });

  it('persists host question render metadata before delivery', async () => {
    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(content);
        return 'telegram-message-1';
      },
    });

    const wizard = startWizard(origin);
    await deliverQuestion(wizard, getQuestion('market_cap'), 'q-market-cap');

    expect(delivered).toHaveLength(1);
    expect(JSON.parse(delivered[0]).questionId).toBe('q-market-cap');
    expect(getAskQuestionRender('q-market-cap')).toMatchObject({ title: 'Screen Market' });
  });

  it('formats preview confirmation text with count and sample', () => {
    expect(buildPreviewQuestion({ total: 3, sample: ['AAPL', 'MSFT'], summary: 'cap: Large Cap' })).toBe(
      'Found 3 tickers matching your filters. Sample: AAPL, MSFT. Screen them all now?',
    );
  });
});
