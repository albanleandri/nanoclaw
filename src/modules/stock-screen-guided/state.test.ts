import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import {
  advanceWizard,
  expireOldWizards,
  getWizardQuestion,
  recordWizardQuestion,
  savePreview,
  saveStepAnswer,
  startWizard,
} from './state.js';

const origin = {
  agentGroupId: 'ag-1',
  sessionId: 's-1',
  messagingGroupId: 'mg-1',
  channelType: 'telegram',
  platformId: 'tg-1',
  threadId: null,
  requestedBy: 'u-1',
};

beforeEach(() => {
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
});

afterEach(() => closeDb());

describe('screen market wizard state', () => {
  it('starts and replaces active wizards for the same origin', () => {
    const first = startWizard(origin, '2024-01-01T00:00:00.000Z');
    const second = startWizard(origin, '2024-01-01T00:01:00.000Z');
    expect(second.id).not.toBe(first.id);
    expect(second.step).toBe('market_cap');
  });

  it('records questions and persists answers and preview', () => {
    const wizard = startWizard(origin);
    recordWizardQuestion(wizard.id, 'market_cap', 'q-1');
    expect(getWizardQuestion('q-1')).toMatchObject({ wizardId: wizard.id, step: 'market_cap' });

    const answered = saveStepAnswer(wizard.id, 'market_cap', ['Large Cap']);
    expect(answered.answers.market_cap).toEqual(['Large Cap']);

    const advanced = advanceWizard(wizard.id, 'sector');
    expect(advanced.step).toBe('sector');

    const previewed = savePreview(wizard.id, { total: 2, sample: ['AAPL', 'MSFT'], summary: 'Large Cap' });
    expect(previewed.status).toBe('preview');
    expect(previewed.preview?.sample).toEqual(['AAPL', 'MSFT']);
  });

  it('expires old active wizards', () => {
    startWizard(origin, '2024-01-01T00:00:00.000Z');
    expect(expireOldWizards('2024-01-01T00:31:00.000Z')).toBe(1);
  });
});
