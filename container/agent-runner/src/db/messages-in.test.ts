import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from './connection.js';
import { markCompleted, markProcessing, markProviderFailed } from './messages-in.js';

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

  // The poll loop calls markCompleted as an unconditional safety net after
  // processQuery returns OR throws. If it could overwrite a terminal ack, a
  // task fire that failed on a dead credential would be re-acked `completed`,
  // the host would record a successful run, and recurrence would advance —
  // the exact silent-schedule-consumption this ack status exists to prevent.
  test('markCompleted does not downgrade a terminal provider-error ack', () => {
    markProcessing(['task-1']);
    markProviderFailed(['task-1']);

    markCompleted(['task-1']);

    const row = getOutboundDb().prepare('SELECT status FROM processing_ack').get() as { status: string };
    expect(row.status).toBe('provider-error');
  });

  test('markCompleted still acks a claim that is still processing', () => {
    markProcessing(['task-2']);

    markCompleted(['task-2']);

    const row = getOutboundDb()
      .prepare("SELECT status FROM processing_ack WHERE message_id = 'task-2'")
      .get() as { status: string };
    expect(row.status).toBe('completed');
  });
});
