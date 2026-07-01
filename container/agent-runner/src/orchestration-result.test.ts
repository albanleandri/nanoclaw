import { describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from './db/connection.js';
import { writeMessageOut } from './db/messages-out.js';
import { clearCurrentInReplyTo, setCurrentInReplyTo } from './current-batch.js';
import { orchestrationMessageIds, runPollLoop, writeOrchestrationResult } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import type { AgentProvider } from './providers/types.js';

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('orchestration result metadata', () => {
  it('selects correlation metadata without depending on message ID shape', () => {
    expect(
      orchestrationMessageIds([
        { id: 'ordinary:1', orchestration_run_id: null },
        { id: 'adapter/id with spaces', orchestration_run_id: 'run:1' },
        { id: 'legacy-without-column' },
      ]),
    ).toEqual(['adapter/id with spaces']);
  });

  it('emits usage for the caller-selected orchestration inputs without raw output', () => {
    const { outbound } = initTestSessionDb();
    writeOrchestrationResult(['message:agent'], 'result', {
      inputTokens: 4,
      outputTokens: 2,
      source: 'provider',
    });
    const row = outbound.prepare("SELECT content FROM messages_out WHERE kind='system'").get() as { content: string };
    expect(JSON.parse(row.content)).toMatchObject({
      action: 'orchestration_result',
      inputMessageIds: ['message:agent'],
      outcome: 'result',
      usage: { inputTokens: 4, outputTokens: 2, source: 'provider' },
    });
    expect(row.content).not.toContain('raw output');
    closeSessionDb();
  });

  it('emits explicit pre-tool failure facts without provider output', () => {
    const { outbound } = initTestSessionDb();
    writeOrchestrationResult(['message:agent'], 'terminal-error', undefined, {
      classification: 'transient',
      retryable: true,
      sideEffectBoundaryCrossed: false,
    });
    const row = outbound.prepare("SELECT content FROM messages_out WHERE kind='system'").get() as { content: string };
    expect(JSON.parse(row.content)).toMatchObject({
      error: {
        classification: 'transient',
        retryable: true,
        sideEffectBoundaryCrossed: false,
      },
    });
    closeSessionDb();
  });

  it('does nothing for an empty orchestration set', () => {
    const { outbound } = initTestSessionDb();
    writeOrchestrationResult([], 'result');
    expect(outbound.prepare('SELECT COUNT(*) AS count FROM messages_out').get()).toEqual({ count: 0 });
    closeSessionDb();
  });

  it('stamps host actions with the active inbound correlation by default', () => {
    const { outbound } = initTestSessionDb();
    setCurrentInReplyTo('adapter-message');
    writeMessageOut({
      id: 'host-action',
      kind: 'system',
      content: JSON.stringify({ action: 'schedule_task' }),
    });
    expect(outbound.prepare('SELECT in_reply_to FROM messages_out WHERE id = ?').get('host-action')).toEqual({
      in_reply_to: 'adapter-message',
    });
    clearCurrentInReplyTo();
    closeSessionDb();
  });

  it('persists the terminal marker before the reply while the provider stream remains open', async () => {
    const { inbound, outbound } = initTestSessionDb();
    inbound
      .prepare(
        `INSERT INTO messages_in
           (id, kind, timestamp, status, trigger, platform_id, channel_type, content, orchestration_run_id)
         VALUES (?, 'chat', datetime('now'), 'pending', 1, ?, ?, ?, ?)`,
      )
      .run('telegram-message', 'chat-42', 'telegram', JSON.stringify({ sender: 'Alban', text: 'hello' }), 'run-1');

    const controller = new AbortController();
    const provider = new MockProvider(
      {},
      () => '<message to="unknown:telegram:chat-42">Hello from the agent</message>',
    );
    let pollLoopSettled = false;
    const running = runPollLoop({
      provider,
      providerName: 'mock',
      cwd: '/tmp',
      stopSignal: controller.signal,
    }).finally(() => {
      pollLoopSettled = true;
    });

    try {
      await waitFor(
        () => (outbound.prepare('SELECT COUNT(*) AS count FROM messages_out').get() as { count: number }).count === 2,
      );

      // This is the critical invariant: runPollLoop has not returned because
      // the provider stream is intentionally held open for follow-ups, yet
      // both rows are already durable and the host-action row precedes the
      // user-facing reply. The host can therefore authorize delivery without
      // waiting for stream shutdown.
      expect(pollLoopSettled).toBe(false);
      const rows = outbound.prepare('SELECT kind, in_reply_to, content FROM messages_out ORDER BY seq').all() as Array<{
        kind: string;
        in_reply_to: string | null;
        content: string;
      }>;
      expect(rows.map((row) => row.kind)).toEqual(['system', 'chat']);
      expect(JSON.parse(rows[0].content)).toMatchObject({
        action: 'orchestration_result',
        inputMessageIds: ['telegram-message'],
        outcome: 'result',
      });
      expect(rows[0].in_reply_to).toBe('telegram-message');
      expect(JSON.parse(rows[1].content)).toEqual({ text: 'Hello from the agent' });
      expect(rows[1].in_reply_to).toBe('telegram-message');
    } finally {
      controller.abort();
      await running;
      closeSessionDb();
    }
  });

  it('persists terminal provider errors before their user-facing notification', async () => {
    const { inbound, outbound } = initTestSessionDb();
    inbound
      .prepare(
        `INSERT INTO messages_in
           (id, kind, timestamp, status, trigger, platform_id, channel_type, content, orchestration_run_id)
         VALUES ('quota-message', 'chat', datetime('now'), 'pending', 1, 'chat-42', 'telegram', ?, 'run-quota')`,
      )
      .run(JSON.stringify({ sender: 'Alban', text: 'hello' }));

    const controller = new AbortController();
    const running = runPollLoop({
      provider: new MockProvider({}, undefined, true),
      providerName: 'mock',
      cwd: '/tmp',
      stopSignal: controller.signal,
    });

    try {
      await waitFor(
        () => (outbound.prepare('SELECT COUNT(*) AS count FROM messages_out').get() as { count: number }).count === 2,
      );
      const rows = outbound.prepare('SELECT kind, content FROM messages_out ORDER BY seq').all() as Array<{
        kind: string;
        content: string;
      }>;
      expect(rows.map((row) => row.kind)).toEqual(['system', 'chat']);
      expect(JSON.parse(rows[0].content)).toMatchObject({
        action: 'orchestration_result',
        inputMessageIds: ['quota-message'],
        outcome: 'terminal-error',
        error: { classification: 'quota', retryable: false },
      });
      expect(JSON.parse(rows[1].content).text).toContain('Usage limit reached');
    } finally {
      controller.abort();
      await running;
      closeSessionDb();
    }
  });

  it('persists thrown provider failures before their user-facing error', async () => {
    const { inbound, outbound } = initTestSessionDb();
    inbound
      .prepare(
        `INSERT INTO messages_in
           (id, kind, timestamp, status, trigger, platform_id, channel_type, content, orchestration_run_id)
         VALUES ('throw-message', 'chat', datetime('now'), 'pending', 1, 'chat-42', 'telegram', ?, 'run-throw')`,
      )
      .run(JSON.stringify({ sender: 'Alban', text: 'hello' }));

    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query: () => ({
        push() {},
        end() {},
        abort() {},
        events: {
          async *[Symbol.asyncIterator]() {
            throw new Error('provider stream failed');
          },
        },
      }),
    };
    const controller = new AbortController();
    const running = runPollLoop({
      provider,
      providerName: 'throwing',
      cwd: '/tmp',
      stopSignal: controller.signal,
    });

    try {
      await waitFor(
        () => (outbound.prepare('SELECT COUNT(*) AS count FROM messages_out').get() as { count: number }).count === 2,
      );
      const rows = outbound.prepare('SELECT kind, content FROM messages_out ORDER BY seq').all() as Array<{
        kind: string;
        content: string;
      }>;
      expect(rows.map((row) => row.kind)).toEqual(['system', 'chat']);
      expect(JSON.parse(rows[0].content)).toMatchObject({
        action: 'orchestration_result',
        inputMessageIds: ['throw-message'],
        outcome: 'exception',
      });
      expect(JSON.parse(rows[1].content)).toEqual({ text: 'Error: provider stream failed' });
    } finally {
      controller.abort();
      await running;
      closeSessionDb();
    }
  });
});
