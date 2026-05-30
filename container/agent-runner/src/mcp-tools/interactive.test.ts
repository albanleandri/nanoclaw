import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { clearCurrentInReplyTo, setCurrentInReplyTo } from '../current-batch.js';
import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { askUserQuestion, sendCard } from './interactive.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  clearCurrentInReplyTo();
  closeSessionDb();
});

function seedInboundCommand(id: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 2, 'chat', datetime('now'), 'pending', 'telegram-user', 'telegram', NULL, ?)`,
    )
    .run(id, JSON.stringify({ text: '/screen-market' }));
}

describe('interactive MCP tools', () => {
  it('ask_user_question correlates the question with the current inbound message and completes it while waiting', async () => {
    seedInboundCommand('inbound-screen-market');
    getOutboundDb()
      .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('runtime:current_in_reply_to', 'inbound-screen-market', new Date().toISOString());

    const result = await askUserQuestion.handler({
      title: 'Screen Market',
      question: 'Which market cap tier?',
      options: ['All'],
      timeout: 0.001,
    });

    expect(result.isError).toBe(true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-screen-market');

    const ack = getOutboundDb()
      .prepare('SELECT status FROM processing_ack WHERE message_id = ?')
      .get('inbound-screen-market') as { status: string } | undefined;
    expect(ack?.status).toBe('completed');
  });

  it('send_card stamps the current inbound message id on outbound cards', async () => {
    setCurrentInReplyTo('inbound-card');

    await sendCard.handler({ card: { title: 'Status' } });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-card');
  });
});
