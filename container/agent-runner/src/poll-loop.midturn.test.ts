import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import type { RoutingContext } from './formatter.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

const ROUTING: RoutingContext = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
  taskFire: false,
};

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id)
       VALUES ('main', 'Main', 'channel', 'discord', 'chan-1')`,
    )
    .run();
});

afterEach(() => closeSessionDb());

type EventStep = ProviderEvent | (() => void);

function stubQuery(events: EventStep[]): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  return {
    pushes,
    query: {
      push(prompt) {
        pushes.push(prompt);
      },
      end() {},
      abort() {},
      events: {
        async *[Symbol.asyncIterator]() {
          for (const step of events) {
            if (typeof step === 'function') step();
            else yield step;
          }
        },
      },
    },
  };
}

function delivered(): Array<{ text: string; channelType: string | null }> {
  return getUndeliveredMessages()
    .filter((row) => row.kind === 'chat')
    .map((row) => ({
      text: (JSON.parse(row.content) as { text: string }).text,
      channelType: row.channel_type,
    }));
}

function toolSend(text: string): void {
  writeMessageOut({
    id: `tool-${text}`,
    kind: 'chat',
    platform_id: 'chan-1',
    channel_type: 'discord',
    thread_id: null,
    content: JSON.stringify({ text }),
  });
}

async function run(events: EventStep[], midTurnCompleteDelivery = true): Promise<string[]> {
  const { query, pushes } = stubQuery(events);
  await processQuery(query, ROUTING, ['m1'], 'claude', {
    midTurnCompleteDelivery,
    activePollIntervalMs: 60_000,
  });
  return pushes;
}

describe('mid-turn single content door', () => {
  it('delivers a wrapped reply before a later tool/result and never repeats it', async () => {
    const block = '<message to="main">answer before tool</message>';
    const pushes = await run([
      { type: 'text', text: block },
      { type: 'result', text: '<internal>tool finished</internal>' },
    ]);

    expect(delivered()).toEqual([{ text: 'answer before tool', channelType: 'discord' }]);
    expect(pushes).toEqual([]);
  });

  it('assembles split tags and bodies while never promoting an internal draft', async () => {
    await run([
      { type: 'text', text: '<internal><message to="main">draft' },
      { type: 'text', text: '</message></internal><mess' },
      { type: 'text', text: 'age to="main">hel' },
      { type: 'text', text: 'lo</message>' },
      { type: 'result', text: '<message to="main">hello</message>' },
    ]);

    expect(delivered()).toEqual([{ text: 'hello', channelType: 'discord' }]);
  });

  it('drops a verbatim block repeated by a later streamed assistant message', async () => {
    const block = '<message to="main">once</message>';
    const pushes = await run([
      { type: 'text', text: block },
      { type: 'text', text: block },
      { type: 'result', text: block },
    ]);

    expect(delivered().map((row) => row.text)).toEqual(['once']);
    expect(pushes).toEqual([]);
  });

  it('recovers a result block missed by the stream through exactly one retry', async () => {
    const block = '<message to="main">recovered</message>';
    const pushes = await run([
      { type: 'result', text: block },
      { type: 'text', text: block },
      { type: 'result', text: block },
    ]);

    expect(delivered().map((row) => row.text)).toEqual(['recovered']);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('was not delivered');
  });

  it('allows the same body again after a real turn boundary', async () => {
    const block = '<message to="main">same, intentionally</message>';
    await run([
      { type: 'text', text: block },
      { type: 'result', text: block },
      { type: 'text', text: block },
      { type: 'result', text: block },
    ]);

    expect(delivered().map((row) => row.text)).toEqual(['same, intentionally', 'same, intentionally']);
  });

  it('keeps task-session text events inert', async () => {
    const { query } = stubQuery([
      { type: 'text', text: '<message to="main">must not send</message>' },
      { type: 'result', text: 'task summary' },
    ]);
    await processQuery(query, { ...ROUTING, taskFire: true }, ['task-1'], 'claude', {
      midTurnCompleteDelivery: true,
      activePollIntervalMs: 60_000,
    });

    expect(delivered()).toEqual([]);
  });

  it('delivers partial output plus a safe failure notice without a retry', async () => {
    const pushes = await run([
      { type: 'text', text: '<message to="main">partial answer</message>' },
      { type: 'result', text: null, isError: true, error: 'Safe provider notice' },
    ]);

    expect(delivered().map((row) => row.text)).toEqual(['partial answer', 'Safe provider notice']);
    expect(pushes).toEqual([]);
  });
});

describe('tool-send recovery and retry deduplication', () => {
  it.each([true, false])('quotes a tool send before accepting a done retry (mid-turn: %p)', async (midTurn) => {
    const pushes = await run(
      [
        () => toolSend('full answer via tool'),
        { type: 'result', text: 'Sent it.' },
        { type: 'result', text: '<internal>done</internal>' },
      ],
      midTurn,
    );

    expect(delivered().map((row) => row.text)).toEqual(['full answer via tool']);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('<sent_message to="main">full answer via tool</sent_message>');
    expect(pushes[0]).toContain('<undelivered_text>Sent it.</undelivered_text>');
  });

  it('recovers an answer omitted after an unflagged acknowledgment', async () => {
    const answer = '<message to="main">The answer is 4.</message>';
    const pushes = await run([
      () => toolSend('On it'),
      { type: 'result', text: 'The answer is 4.' },
      { type: 'text', text: answer },
      { type: 'result', text: answer },
    ]);

    expect(delivered().map((row) => row.text)).toEqual(['On it', 'The answer is 4.']);
    expect(pushes).toHaveLength(1);
  });

  it.each([true, false])('never repeats a tool send on the nudge retry (mid-turn: %p)', async (midTurn) => {
    const block = '<message to="main">already sent</message>';
    const retryEvents: EventStep[] = [() => toolSend('already sent'), { type: 'result', text: 'Sent.' }];
    if (midTurn) retryEvents.push({ type: 'text', text: block });
    retryEvents.push({ type: 'result', text: block });

    const pushes = await run(retryEvents, midTurn);

    expect(delivered().map((row) => row.text)).toEqual(['already sent']);
    expect(pushes).toHaveLength(1);
  });

  it('nudges an unknown result destination even after another block streamed', async () => {
    const pushes = await run([
      { type: 'text', text: '<message to="main">delivered</message>' },
      {
        type: 'result',
        text: '<message to="main">delivered</message><message to="missing">lost unless nudged</message>',
      },
      { type: 'result', text: '<internal>done</internal>' },
    ]);

    expect(delivered().map((row) => row.text)).toEqual(['delivered']);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('lost unless nudged');
    expect(pushes[0]).toContain('<sent_message to="main">delivered</sent_message>');
  });
});

describe('persistent-query turn routing', () => {
  it('adopts a warm follow-up route only after the current result boundary', async () => {
    const pushes: string[] = [];
    const query: AgentQuery = {
      push(prompt) {
        pushes.push(prompt);
      },
      end() {},
      abort() {},
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'result', text: '<internal>initial done</internal>' } as ProviderEvent;
          getInboundDb()
            .prepare(
              `INSERT INTO messages_in
                 (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
               VALUES ('m2', 'chat', datetime('now'), 'pending', 1, 'chan-2', 'telegram', 'thread-2', '{"text":"next"}')`,
            )
            .run();
          for (let attempt = 0; attempt < 50 && pushes.length === 0; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 2));
          }
          toolSend('follow-up tool send');
          yield { type: 'result', text: null, isError: true, error: 'Follow-up failed safely' } as ProviderEvent;
        },
      },
    };

    await processQuery(query, ROUTING, ['m1'], 'claude', {
      midTurnCompleteDelivery: true,
      activePollIntervalMs: 1,
    });

    expect(pushes).toHaveLength(1);
    expect(delivered()).toContainEqual({ text: 'Follow-up failed safely', channelType: 'telegram' });
    const notice = getUndeliveredMessages().find(
      (row) => (JSON.parse(row.content) as { text: string }).text === 'Follow-up failed safely',
    );
    expect(notice?.platform_id).toBe('chan-2');
    expect(notice?.thread_id).toBe('thread-2');
    const toolRow = getUndeliveredMessages().find(
      (row) => (JSON.parse(row.content) as { text: string }).text === 'follow-up tool send',
    );
    expect(toolRow?.in_reply_to).toBe('m2');
  });
});
