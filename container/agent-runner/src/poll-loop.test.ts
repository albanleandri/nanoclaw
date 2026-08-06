import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getPendingMessages, markCompleted, type MessageInRow } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { formatMessages, extractRouting } from './formatter.js';
import { isCorruptionError } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';
import { formatMessagesWithCommands, processQuery, runnerIdleExpired } from './poll-loop.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { processAfter?: string; trigger?: 0 | 1; onWake?: 0 | 1 },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, kind, opts?.processAfter ?? null, opts?.trigger ?? 1, opts?.onWake ?? 0, JSON.stringify(content));
}

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as distinct <message> blocks', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    // The <messages> envelope was dropped in fe2e881b (#2556) so the SDK calls
    // the API; each message is now its own self-contained <message> block.
    expect(prompt).not.toContain('<messages>');
    expect(prompt.match(/<message /g) ?? []).toHaveLength(2);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<task');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('source="github"');
    expect(prompt).toContain('event="push"');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('action="register_group"');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('<system_response');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('runner idle slot release', () => {
  it('expires only at the configured idle boundary', () => {
    expect(runnerIdleExpired(1_000, 1_999, 1_000)).toBe(false);
    expect(runnerIdleExpired(1_000, 2_000, 1_000)).toBe(true);
  });
});

describe('on_wake filtering', () => {
  it('first poll returns on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('subsequent polls skip on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(0);
  });

  it('normal messages returned regardless of isFirstPoll', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'hello' });
    expect(getPendingMessages(true)).toHaveLength(1);

    // Reset: mark completed so we can re-test with a fresh message
    markCompleted(['m1']);
    insertMessage('m2', 'chat', { sender: 'A', text: 'hello again' });
    expect(getPendingMessages(false)).toHaveLength(1);
  });

  it('mixed batch: first poll returns both normal and on_wake messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('mixed batch: subsequent poll returns only normal messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('on_wake defaults to 0 for inserts without explicit value', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    // Should be returned even on non-first poll (on_wake=0)
    expect(getPendingMessages(false)).toHaveLength(1);
  });
});

describe('slash command formatting', () => {
  it('wraps unknown slash commands as chat even for native-slash providers', () => {
    insertMessage('m-screen', 'chat-sdk', {
      sender: 'Andy',
      text: '/screen-market',
      author: { userId: '123' },
    });

    const prompt = formatMessagesWithCommands(getPendingMessages(), true);

    expect(prompt).toContain('<context timezone=');
    expect(prompt).toContain('<message ');
    expect(prompt).toContain('/screen-market');
    expect(prompt).not.toBe('/screen-market');
  });

  it('passes known admin commands raw for native-slash providers', () => {
    insertMessage('m-cost', 'chat-sdk', {
      sender: 'Andy',
      text: '/cost',
      author: { userId: '123' },
    });

    expect(formatMessagesWithCommands(getPendingMessages(), true)).toBe('/cost');
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });
});

describe('origin metadata (from= attribute)', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function insertWithRouting(
    id: string,
    kind: string,
    content: object,
    channelType: string | null,
    platformId: string | null,
  ): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?)`,
      )
      .run(id, kind, platformId, channelType, JSON.stringify(content));
  }

  it('chat message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="discord-main"');
  });

  it('chat message falls back to raw routing when no destination matches', () => {
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'telegram', 'chat-999');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="unknown:telegram:chat-999"');
  });

  it('chat message omits from= when routing is null', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).not.toContain('from=');
  });

  it('task message includes from= when destination matches', () => {
    seedDestination('slack-ops', 'slack', 'C-OPS');
    insertWithRouting('t1', 'task', { prompt: 'check status' }, 'slack', 'C-OPS');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).toContain('from="slack-ops"');
  });

  it('task message omits from= when routing is null', () => {
    insertMessage('t1', 'task', { prompt: 'check status' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).not.toContain('from=');
  });

  it('webhook message includes from= when destination matches', () => {
    seedDestination('github-ch', 'github', 'repo-1');
    insertWithRouting('w1', 'webhook', { source: 'github', event: 'push', payload: {} }, 'github', 'repo-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('from="github-ch"');
  });

  it('system message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('s1', 'system', { action: 'test', status: 'ok', result: null }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('from="discord-main"');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    expect(typed[1].type).toBe('result');
    expect((typed[1] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('processQuery heartbeat', () => {
  async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
      await sleep(5);
    }
  }

  function followUpRow(id: string): MessageInRow {
    return {
      id,
      seq: null,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      status: 'pending',
      process_after: null,
      recurrence: null,
      tries: 0,
      trigger: 1,
      platform_id: null,
      channel_type: null,
      thread_id: null,
      content: JSON.stringify({ sender: 'A', text: 'follow up' }),
    };
  }

  it('does not complete a follow-up just because provider.push accepted it', async () => {
    let release: (() => void) | null = null;
    let pushedAck: (() => void) | null = null;
    let pendingReturned = false;
    const ackStatus = new Map<string, string>();
    const query: AgentQuery = {
      push(_message: string, ack?: () => void) {
        pushedAck = ack ?? null;
      },
      end() {
        release?.();
      },
      abort() {
        release?.();
      },
      events: {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
          yield { type: 'init', continuation: 'session-1' };
          yield { type: 'result', text: '<internal>initial done</internal>' };
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      },
    };

    const running = processQuery(query, extractRouting([]), ['m-initial'], 'mock', {
      postResultHeartbeatMs: 5,
      activePollIntervalMs: 5,
      getPendingMessages: () => {
        if (pendingReturned) return [];
        pendingReturned = true;
        return [followUpRow('m-follow-up')];
      },
      markProcessing: (ids) => ids.forEach((id) => ackStatus.set(id, 'processing')),
      markCompleted: (ids) => ids.forEach((id) => ackStatus.set(id, 'completed')),
    });

    try {
      await waitFor(() => ackStatus.get('m-follow-up') === 'processing' && pushedAck !== null);
      expect(pushedAck).toBeTypeOf('function');
      expect(ackStatus.get('m-follow-up')).toBe('processing');
    } finally {
      query.end();
      await running;
    }
  });

  it('completes a pushed follow-up when the provider acknowledges its result', async () => {
    let release: (() => void) | null = null;
    let pushedAck: (() => void) | null = null;
    let pendingReturned = false;
    const ackStatus = new Map<string, string>();
    const query: AgentQuery = {
      push(_message: string, ack?: () => void) {
        pushedAck = ack ?? null;
      },
      end() {
        release?.();
      },
      abort() {
        release?.();
      },
      events: {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
          yield { type: 'init', continuation: 'session-1' };
          yield { type: 'result', text: '<internal>initial done</internal>' };
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      },
    };

    const running = processQuery(query, extractRouting([]), ['m-initial'], 'mock', {
      postResultHeartbeatMs: 5,
      activePollIntervalMs: 5,
      getPendingMessages: () => {
        if (pendingReturned) return [];
        pendingReturned = true;
        return [followUpRow('m-follow-up')];
      },
      markProcessing: (ids) => ids.forEach((id) => ackStatus.set(id, 'processing')),
      markCompleted: (ids) => ids.forEach((id) => ackStatus.set(id, 'completed')),
    });

    try {
      await waitFor(() => ackStatus.get('m-follow-up') === 'processing' && pushedAck !== null);
      pushedAck!();
      await waitFor(() => ackStatus.get('m-follow-up') === 'completed');
    } finally {
      query.end();
      await running;
    }
  });

  it('continues heartbeating while waiting for follow-ups after a result', async () => {
    const provider = new MockProvider({}, () => '<internal>done</internal>');
    const query = provider.query({ prompt: 'hello', cwd: '/tmp' });
    const routing = extractRouting([]);
    let heartbeats = 0;

    const running = processQuery(query, routing, ['m1'], 'mock', {
      touchHeartbeat: () => {
        heartbeats += 1;
      },
      postResultHeartbeatMs: 5,
      activePollIntervalMs: 5,
    });

    for (let i = 0; i < 100 && heartbeats < 4; i += 1) {
      await sleep(1);
    }
    expect(heartbeats).toBeGreaterThanOrEqual(4);
    const afterResultEvents = heartbeats;

    await sleep(25);

    try {
      expect(heartbeats).toBeGreaterThan(afterResultEvents);
    } finally {
      query.end();
      await running;
    }
  });

  it('ends a completed provider stream after the post-result idle window', async () => {
    let ended = false;
    let release: (() => void) | null = null;
    const query: AgentQuery = {
      push() {},
      end() {
        ended = true;
        release?.();
      },
      abort() {
        release?.();
      },
      events: {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
          yield { type: 'result', text: '<internal>done</internal>' };
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      },
    };

    const result = await processQuery(query, extractRouting([]), ['m1'], 'mock', {
      activePollIntervalMs: 2,
      postResultHeartbeatMs: 2,
      postResultIdleExitMs: 10,
    });

    expect(ended).toBe(true);
    expect(result.idleExpired).toBe(true);
    expect(result.outcome).toBe('result');
  });

  it('resets the post-result idle deadline when a follow-up arrives', async () => {
    let release: (() => void) | null = null;
    let followUpReturned = false;
    let pushed = false;
    const query: AgentQuery = {
      push(_prompt, onConsumed) {
        pushed = true;
        onConsumed?.();
      },
      end() {
        release?.();
      },
      abort() {
        release?.();
      },
      events: {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
          yield { type: 'result', text: '<internal>done</internal>' };
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      },
    };
    const startedAt = Date.now();

    const result = await processQuery(query, extractRouting([]), ['m1'], 'mock', {
      activePollIntervalMs: 2,
      postResultHeartbeatMs: 2,
      postResultIdleExitMs: 20,
      getPendingMessages: () => {
        if (followUpReturned || Date.now() - startedAt < 12) return [];
        followUpReturned = true;
        return [followUpRow('m-follow-up')];
      },
      markProcessing: () => {},
      markCompleted: () => {},
    });

    expect(pushed).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
    expect(result.idleExpired).toBe(true);
  });

  it('does not synthesize heartbeats before the first provider result', async () => {
    let release: (() => void) | null = null;
    const query: AgentQuery = {
      push() {},
      end() {
        release?.();
      },
      abort() {
        release?.();
      },
      events: {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      },
    };
    const routing = extractRouting([]);
    let heartbeats = 0;

    const running = processQuery(query, routing, ['m1'], 'mock', {
      touchHeartbeat: () => {
        heartbeats += 1;
      },
      postResultHeartbeatMs: 5,
      activePollIntervalMs: 5,
    });

    await sleep(25);

    expect(heartbeats).toBe(0);
    query.end();
    await running;
  });
});

describe('quota error notification', () => {
  function insertWithRouting(id: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
         VALUES (?, 'chat', datetime('now'), 'pending', 'chat-42', 'telegram', 'thread-7', '{"text":"hi"}')`,
      )
      .run(id);
  }

  it('writes a usage-limit notification to messages_out when provider emits quota error', async () => {
    insertWithRouting('m1');
    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    const provider = new MockProvider({}, undefined, true);
    const query = provider.query({ prompt: formatMessages(messages), cwd: '/tmp' });

    await processQuery(query, routing, ['m1'], 'mock');

    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    const content = JSON.parse(outMessages[0].content) as { text: string };
    expect(content.text).toContain('Usage limit reached');
  });

  it('routes the quota notification to the correct channel', async () => {
    insertWithRouting('m1');
    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    const provider = new MockProvider({}, undefined, true);
    const query = provider.query({ prompt: formatMessages(messages), cwd: '/tmp' });

    await processQuery(query, routing, ['m1'], 'mock');

    const [out] = getUndeliveredMessages();
    expect(out.platform_id).toBe('chat-42');
    expect(out.channel_type).toBe('telegram');
    expect(out.thread_id).toBe('thread-7');
  });

  it('writes a usage-limit notification when provider returns a bare 429 API error result', async () => {
    insertWithRouting('m1');
    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    const provider = new MockProvider(
      {},
      () =>
        "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.",
    );
    const query = provider.query({ prompt: formatMessages(messages), cwd: '/tmp' });

    await processQuery(query, routing, ['m1'], 'mock');

    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    const content = JSON.parse(outMessages[0].content) as { text: string };
    expect(content.text).toContain('Usage limit reached');
    expect(outMessages[0].platform_id).toBe('chat-42');
    expect(outMessages[0].channel_type).toBe('telegram');
    expect(outMessages[0].thread_id).toBe('thread-7');
  });

  it('non-quota error events do not write a usage-limit notification', async () => {
    // api_retry is retryable=true, no classification — should not produce a notification
    insertWithRouting('m1');
    const messages = getPendingMessages();
    const routing = extractRouting(messages);

    // Provide a mock that returns normally (no quota error) — quota path must not fire on clean result
    const provider = new MockProvider({}, () => '<message to="default">ok</message>');
    const query = provider.query({ prompt: formatMessages(messages), cwd: '/tmp' });
    setTimeout(() => query.end(), 50);

    await processQuery(query, routing, ['m1'], 'mock');

    const outMessages = getUndeliveredMessages();
    const usageLimitMsgs = outMessages.filter((m) => {
      const c = JSON.parse(m.content) as { text?: string };
      return c.text?.includes('Usage limit reached');
    });
    expect(usageLimitMsgs).toHaveLength(0);
  });
});

function makeResultQuery(result: ProviderEvent): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    yield result;
  }
  return {
    pushes,
    query: {
      push(message: string) {
        pushes.push(message);
      },
      end() {},
      abort() {},
      events: events(),
    },
  };
}

describe('error result with no message envelope', () => {
  const routing = {
    platformId: 'chan-1',
    channelType: 'discord',
    threadId: null,
    inReplyTo: 'm1',
  };

  it('delivers a provider-marked billing/budget error to the triggering channel and does not nudge', async () => {
    const budgetText = 'Spending limit reached. Add your own key at https://example.com/keys';
    const { query, pushes } = makeResultQuery({ type: 'result', text: budgetText, isError: true } as ProviderEvent);

    await processQuery(query, routing, ['m1'], 'mock');

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe(budgetText);
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    expect(pushes).toHaveLength(0);
  });

  it('still nudges a normal unwrapped result', async () => {
    const { query, pushes } = makeResultQuery({ type: 'result', text: 'bare text, no envelope' });

    await processQuery(query, routing, ['m1'], 'mock');

    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('was not delivered');
  });
});

describe('auth error notification', () => {
  function insertWithRouting(id: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
         VALUES (?, 'chat', datetime('now'), 'pending', 'chat-42', 'telegram', 'thread-7', '{"text":"hi"}')`,
      )
      .run(id);
  }

  it('surfaces an auth-error notification when the provider returns a bare 401 API error result', async () => {
    // The credential-outage symptom: the container reaches Claude with a dead
    // OAuth token, the SDK returns a bare authentication error as result text,
    // and (before this fix) the poll loop treated it as unwrapped scratchpad
    // and silently sent nothing. The user must instead get a Telegram message.
    insertWithRouting('m1');
    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    const provider = new MockProvider(
      {},
      () =>
        'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}',
    );
    const query = provider.query({ prompt: formatMessages(messages), cwd: '/tmp' });

    await processQuery(query, routing, ['m1'], 'mock');

    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    const content = JSON.parse(outMessages[0].content) as { text: string };
    expect(content.text.toLowerCase()).toContain('authentication');
    expect(outMessages[0].platform_id).toBe('chat-42');
    expect(outMessages[0].channel_type).toBe('telegram');
    expect(outMessages[0].thread_id).toBe('thread-7');
  });

  it('recognizes the OAuth access-token expiry wording returned by Anthropic', async () => {
    insertWithRouting('m1');
    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    const provider = new MockProvider({}, () => 'API Error: 401 OAuth access token has expired. Re-authenticate.');
    const query = provider.query({ prompt: formatMessages(messages), cwd: '/tmp' });

    await processQuery(query, routing, ['m1'], 'mock');

    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    const content = JSON.parse(outMessages[0].content) as { text: string };
    expect(content.text).toContain("couldn't reach Claude");
    expect(content.text).not.toContain('OAuth access token has expired');
  });

  it('suppresses a late auth error after the initial persistent turn completed', async () => {
    insertWithRouting('m1');
    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    const query: AgentQuery = {
      push() {},
      end() {},
      abort() {},
      events: {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
          yield { type: 'result', text: '<message to="default">done</message>' };
          yield { type: 'error', message: '401 Unauthorized', retryable: true, classification: 'auth' };
        },
      },
    };

    await processQuery(query, routing, ['m1'], 'mock');

    const authMessages = getUndeliveredMessages().filter((message) =>
      (JSON.parse(message.content) as { text: string }).text.toLowerCase().includes('authentication'),
    );
    expect(authMessages).toHaveLength(0);
  });

  it('deduplicates auth notices across queries and resets after an empty successful result', async () => {
    insertWithRouting('m1');
    const routing = extractRouting(getPendingMessages());
    const authQuery = (): AgentQuery => ({
      push() {},
      end() {},
      abort() {},
      events: {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
          yield { type: 'error', message: '401 Unauthorized', retryable: true, classification: 'auth' };
        },
      },
    });
    const successQuery: AgentQuery = {
      push() {},
      end() {},
      abort() {},
      events: {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
          yield { type: 'result' };
        },
      },
    };

    await processQuery(authQuery(), routing, ['m1'], 'mock');
    await processQuery(authQuery(), routing, ['m2'], 'mock');
    expect(getUndeliveredMessages()).toHaveLength(1);

    await processQuery(successQuery, routing, ['m3'], 'mock');
    await processQuery(authQuery(), routing, ['m4'], 'mock');
    expect(getUndeliveredMessages()).toHaveLength(2);
  });

  it('does not surface an auth notification on a normal wrapped result', async () => {
    insertWithRouting('m1');
    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    const provider = new MockProvider({}, () => '<message to="default">all good</message>');
    const query = provider.query({ prompt: formatMessages(messages), cwd: '/tmp' });
    setTimeout(() => query.end(), 50);

    await processQuery(query, routing, ['m1'], 'mock');

    const authMsgs = getUndeliveredMessages().filter((m) => {
      const c = JSON.parse(m.content) as { text?: string };
      return c.text?.toLowerCase().includes('authentication');
    });
    expect(authMsgs).toHaveLength(0);
  });

  it('surfaces an auth notification when the provider emits an error event classified as auth', async () => {
    insertWithRouting('m1');
    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    const query: AgentQuery = {
      push() {},
      end() {},
      abort() {},
      events: {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
          yield { type: 'init', continuation: 'sess-auth' };
          yield { type: 'error', message: '401 Unauthorized', retryable: true, classification: 'auth' };
        },
      },
    };

    await processQuery(query, routing, ['m1'], 'mock');

    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    const content = JSON.parse(outMessages[0].content) as { text: string };
    expect(content.text.toLowerCase()).toContain('authentication');
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});

describe('isCorruptionError', () => {
  it('matches the Docker Desktop macOS torn-read symptom', () => {
    expect(isCorruptionError('database disk image is malformed')).toBe(true);
  });

  it('matches wrapped SQLite corruption codes', () => {
    expect(isCorruptionError('SqliteError: SQLITE_CORRUPT_VTAB: ...')).toBe(true);
    expect(isCorruptionError('file is not a database')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isCorruptionError('database is locked')).toBe(false);
    expect(isCorruptionError('no such table: messages_in')).toBe(false);
    expect(isCorruptionError('')).toBe(false);
  });
});

describe('processQuery terminal outcome', () => {
  it('returns outcome "result" when the provider produces a result', async () => {
    const provider = new MockProvider({}, () => '<message to="default">ok</message>');
    const query = provider.query({ prompt: 'hi', cwd: '/tmp' });
    setTimeout(() => query.end(), 20);

    const result = await processQuery(query, extractRouting([]), ['m1'], 'mock');

    expect(result.outcome).toBe('result');
  });

  it('returns outcome "terminal-error" when the provider emits a quota error', async () => {
    const provider = new MockProvider({}, undefined, true);
    const query = provider.query({ prompt: 'hi', cwd: '/tmp' });

    const result = await processQuery(query, extractRouting([]), ['m1'], 'mock');

    expect(result.outcome).toBe('terminal-error');
  });

  it('surfaces an error and completes the batch when the stream closes without a terminal event', async () => {
    insertRoutedTerminalTestMessage();
    const completed = new Set<string>();
    const query = terminalTestQuery(async function* () {
      yield { type: 'init', continuation: 'sess-1' };
    });

    const result = await processQuery(query, extractRouting(getPendingMessages()), ['m1'], 'mock', {
      markCompleted: (ids) => ids.forEach((id) => completed.add(id)),
    });

    expect(result.outcome).toBe('silent-close');
    expect(completed.has('m1')).toBe(true);
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect((JSON.parse(out[0].content) as { text: string }).text).toContain('without producing a response');
    expect(out[0].platform_id).toBe('chat-9');
    expect(out[0].channel_type).toBe('telegram');
    expect(out[0].thread_id).toBe('thread-3');
  });

  it('treats a stream that yields no events at all as a silent close', async () => {
    insertRoutedTerminalTestMessage();
    const completed = new Set<string>();
    const query = terminalTestQuery(async function* () {});

    const result = await processQuery(query, extractRouting(getPendingMessages()), ['m1'], 'mock', {
      markCompleted: (ids) => ids.forEach((id) => completed.add(id)),
    });

    expect(result.outcome).toBe('silent-close');
    expect(completed.has('m1')).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('does not surface an error when the host stop signal aborts the turn', async () => {
    insertRoutedTerminalTestMessage();
    const completed = new Set<string>();
    const controller = new AbortController();
    let release: (() => void) | null = null;
    const query: AgentQuery = {
      push() {},
      end() {
        release?.();
      },
      abort() {
        release?.();
      },
      events: {
        async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
          yield { type: 'init', continuation: 'sess-1' };
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      },
    };

    const running = processQuery(query, extractRouting(getPendingMessages()), ['m1'], 'mock', {
      stopSignal: controller.signal,
      markCompleted: (ids) => ids.forEach((id) => completed.add(id)),
    });
    await sleep(0);
    controller.abort();
    const result = await running;

    expect(result.outcome).toBe('interrupted');
    expect(completed.has('m1')).toBe(false);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

function insertRoutedTerminalTestMessage(): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chat-9', 'telegram', 'thread-3', '{"text":"hi"}')`,
    )
    .run();
}

function terminalTestQuery(events: () => AsyncGenerator<ProviderEvent, void, unknown>): AgentQuery {
  return {
    push() {},
    end() {},
    abort() {},
    events: { [Symbol.asyncIterator]: events },
  };
}
