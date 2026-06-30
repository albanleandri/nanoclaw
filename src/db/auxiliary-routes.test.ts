import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from './index.js';
import { getAuxiliaryRoute, listAuxiliaryRoutes, setAuxiliaryRoute } from './auxiliary-routes.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  for (const id of ['source', 'target']) {
    createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  }
});
afterEach(closeDb);

describe('auxiliary routes', () => {
  it('defaults missing roles to disabled and persists explicit targets', () => {
    expect(getAuxiliaryRoute('source', 'review')).toEqual({ kind: 'disabled' });
    setAuxiliaryRoute('source', 'review', { kind: 'main' });
    setAuxiliaryRoute('source', 'classification', { kind: 'agent', agentGroupId: 'target' });
    expect(getAuxiliaryRoute('source', 'review')).toEqual({ kind: 'main' });
    expect(listAuxiliaryRoutes('source')).toEqual([
      { role: 'classification', target: { kind: 'agent', agentGroupId: 'target' } },
      { role: 'review', target: { kind: 'main' } },
    ]);
  });

  it('rejects unknown agent targets', () => {
    expect(() => setAuxiliaryRoute('source', 'review', { kind: 'agent', agentGroupId: 'missing' })).toThrow(
      /not found/,
    );
  });
});
