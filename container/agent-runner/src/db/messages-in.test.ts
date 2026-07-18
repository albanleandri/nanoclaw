import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from './connection.js';
import { markCompleted, markProcessing } from './messages-in.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('processing acknowledgement timestamps', () => {
  test('stores ISO UTC instants for processing and completed states', () => {
    markProcessing(['message-1']);
    let row = getOutboundDb().prepare('SELECT status, status_changed FROM processing_ack').get() as {
      status: string;
      status_changed: string;
    };
    expect(row.status).toBe('processing');
    expect(row.status_changed).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    markCompleted(['message-1']);
    row = getOutboundDb().prepare('SELECT status, status_changed FROM processing_ack').get() as typeof row;
    expect(row.status).toBe('completed');
    expect(row.status_changed).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
});
