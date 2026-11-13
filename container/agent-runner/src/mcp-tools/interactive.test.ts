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

  it('send_card accepts validated fields, tables, charts and dividers', async () => {
    const children = [
      { type: 'Fields', children: [{ type: 'Field', props: { label: 'p50', value: '42 ms' } }] },
      { type: 'Table', props: { headers: ['Market', 'Score'], rows: [['CH', 8.4]] } },
      {
        type: 'Chart',
        props: {
          title: 'Scores',
          chart: { type: 'bar', categories: ['CH'], series: [{ name: 'Score', values: [8.4] }] },
        },
      },
      { type: 'Divider' },
    ];

    const result = await sendCard.handler({ card: { title: 'Screen', children } });

    expect(result.isError).toBeUndefined();
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).card.children).toEqual(children);
  });

  const field = (label: string, value: string | number) => ({ type: 'Field', props: { label, value } });
  const table = (rows: unknown[], headers = ['Scale', 'Before', 'After']) => ({
    type: 'Table',
    props: { headers, rows },
  });
  const chart = (title: string, spec: Record<string, unknown>) => ({
    type: 'Chart',
    props: { title, chart: spec },
  });
  const bar = (title = 'Latency') =>
    chart(title, { type: 'bar', categories: ['1x', '2x'], series: [{ name: 'Before', values: [40, 80] }] });

  it.each([
    ['a callback button', { type: 'Button', props: { id: 'approve', label: 'Approve' } }, 'unknown part "Button"'],
    ['an empty Fields', { type: 'Fields', children: [] }, 'Fields needs at least one Field'],
    [
      'a non-Field inside Fields',
      { type: 'Fields', children: [{ type: 'Button', props: { label: 'x' } }] },
      'Fields holds only Field parts',
    ],
    [
      'a field with no value',
      { type: 'Fields', children: [{ type: 'Field', props: { label: 'p95' } }] },
      'props.label and props.value',
    ],
    ['an overlong field', { type: 'Fields', children: [field('p95', 'x'.repeat(1_500))] }, 'at most 1500'],
    ['a table with missing headers', { type: 'Table', props: { rows: [] } }, 'props.headers'],
    ['a table with non-list rows', { type: 'Table', props: { headers: ['a'], rows: {} } }, 'props.rows'],
    ['a table of 31 rows', table(Array.from({ length: 31 }, () => ['1x', '40', '38'])), 'at most 30 rows'],
    [
      'a table of 7 columns',
      table([['a', 'b', 'c', 'd', 'e', 'f', 'g']], ['1', '2', '3', '4', '5', '6', '7']),
      'at most 6 columns',
    ],
    ['an object table row', table([{ Scale: '1x' }]), 'row 0 must be a list'],
    ['a short table row', table([['1x', '40']]), 'row 0 has 2 cells'],
    ['a non-scalar table cell', table([['1x', {}, '38']]), 'cell must be text or a number'],
    ['a blank table', { type: 'Table', props: { headers: [' '], rows: [[' ']] } }, 'table has no text to show'],
    [
      'an invalid alignment',
      { type: 'Table', props: { headers: ['a'], rows: [['1']], align: ['middle'] } },
      'props.align',
    ],
    ['a non-text caption', { type: 'Table', props: { headers: ['a'], rows: [['1']], caption: 4 } }, 'props.caption'],
    ['an overlong table', table([['x'.repeat(10_000), 'a', 'b']]), 'at most 10000'],
    ['a chart without a title', chart('', { type: 'pie', segments: [{ label: 'a', value: 1 }] }), 'props.title'],
    ['an unknown chart', chart('Latency', { type: 'radar' }), 'pie, bar, line or area'],
    ['an empty pie', chart('Split', { type: 'pie', segments: [] }), '1 to 12 slices'],
    ['a zero pie slice', chart('Split', { type: 'pie', segments: [{ label: 'a', value: 0 }] }), 'above 0'],
    [
      'repeated pie labels',
      chart('Split', {
        type: 'pie',
        segments: [
          { label: 'a', value: 1 },
          { label: 'a', value: 2 },
        ],
      }),
      'must not repeat',
    ],
    [
      'empty categories',
      chart('Latency', { type: 'line', categories: [], series: [{ name: 'B', values: [] }] }),
      '1 to 20 categories',
    ],
    ['empty series', chart('Latency', { type: 'line', categories: ['1x'], series: [] }), '1 to 12 series'],
    [
      'a short series',
      chart('Latency', { type: 'line', categories: ['1x', '2x'], series: [{ name: 'B', values: [1] }] }),
      'has 1 values, expected 2',
    ],
    [
      'a non-finite value',
      chart('Latency', { type: 'bar', categories: ['1x'], series: [{ name: 'B', values: [Infinity] }] }),
      'values must be numbers',
    ],
    [
      'repeated categories',
      chart('Latency', { type: 'area', categories: ['1x', '1x'], series: [{ name: 'B', values: [1, 2] }] }),
      'must not repeat',
    ],
    [
      'an overlong axis',
      chart('Latency', {
        type: 'bar',
        categories: ['1x'],
        series: [{ name: 'B', values: [1] }],
        xLabel: 'x'.repeat(51),
      }),
      'axis labels',
    ],
    [
      'an overlong label',
      chart('Latency', { type: 'bar', categories: ['x'.repeat(21)], series: [{ name: 'B', values: [1] }] }),
      'at most 20 characters',
    ],
    ['an empty Text part', { type: 'Text', props: { content: '' } }, 'props.content'],
    ['an invalid Text style', { type: 'Text', props: { content: 'x', style: 'huge' } }, 'plain, bold or muted'],
  ])('send_card refuses %s without enqueueing a row', async (_, part, reason) => {
    const result = await sendCard.handler({ card: { title: 'Unsafe', children: ['intro', part] } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('children[1]');
    expect(result.content[0].text).toContain(reason);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it.each([
    ['11 parts', Array.from({ length: 11 }, () => ({ type: 'Divider' })), 'at most 10 parts'],
    [
      '11 fields',
      [
        { type: 'Fields', children: Array.from({ length: 6 }, (_, i) => field(`f${i}`, '1')) },
        { type: 'Fields', children: Array.from({ length: 5 }, (_, i) => field(`g${i}`, '1')) },
      ],
      'at most 10 fields',
    ],
    [
      'too much text',
      Array.from({ length: 5 }, () => ({ type: 'Text', props: { content: 'x'.repeat(2_500) } })),
      'at most 12000 per card',
    ],
    ['two tables', [table([['1x', '40', '38']]), table([['2x', '80', '61']])], 'at most 1 Table'],
    ['three charts', [bar('a'), bar('b'), bar('c')], 'at most 2 Charts'],
  ])('send_card refuses aggregate limit: %s', async (_, children, reason) => {
    const result = await sendCard.handler({ card: { title: 'Unsafe', children } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(reason);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
