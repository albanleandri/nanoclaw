/**
 * create_agent only writes the outbound request; the host authorizes it. The
 * requestId inside the content must equal the row id — the host correlates
 * its "agent ready" notification by it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { createAgent } from './agents.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('create_agent', () => {
  it('requires a name', async () => {
    const result = (await createAgent.handler({})) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(getUndeliveredMessages()).toEqual([]);
  });

  it('writes a create_agent request correlated by its row id', async () => {
    await createAgent.handler({ name: 'Researcher', instructions: 'Find sources.' });
    const [row] = getUndeliveredMessages();
    expect(row.kind).toBe('system');
    expect(JSON.parse(row.content)).toEqual({
      action: 'create_agent',
      requestId: row.id,
      name: 'Researcher',
      instructions: 'Find sources.',
    });
  });

  it('stores missing instructions as null', async () => {
    await createAgent.handler({ name: 'Helper' });
    expect(JSON.parse(getUndeliveredMessages()[0].content).instructions).toBeNull();
  });
});
