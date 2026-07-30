/**
 * v1-parity tests for formatter behavior.
 *
 * Port of src/v1/formatting.test.ts (at commit 27c5220, parent of the v1
 * deletion commit 86becf8). Covers: context timezone header, reply_to +
 * quoted_message rendering, XML escaping, and stripInternalTags.
 *
 * Timestamp-format assertions use `formatLocalTime()` output format, which
 * is host locale-dependent for decorators (month abbr, "," separator) but
 * stable for the numeric parts we assert on (hour, minute, year).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { getPendingMessages } from './db/messages-in.js';
import type { MessageInRow } from './db/messages-in.js';
import { categorizeMessage, extractRouting, formatMessages, isClearCommand, stripInternalTags } from './formatter.js';
import { TIMEZONE } from './timezone.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(id: string, kind: string, content: object, opts?: { timestamp?: string }) {
  const timestamp = opts?.timestamp ?? new Date().toISOString();
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, content)
       VALUES (?, ?, ?, 'pending', ?)`,
    )
    .run(id, kind, timestamp, JSON.stringify(content));
}

describe('context timezone header', () => {
  it('prepends <context timezone="..."/> to formatted output', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hello' });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain(`<context timezone="${TIMEZONE}"`);
  });

  it('includes the header even when the message list is empty', () => {
    const result = formatMessages([]);
    expect(result).toContain(`<context timezone="${TIMEZONE}"`);
  });

  it('header comes before the first <message> block when multiple are present', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'one' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'two' });
    const result = formatMessages(getPendingMessages());
    const ctxIdx = result.indexOf('<context');
    const firstMsgIdx = result.indexOf('<message ');
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(firstMsgIdx).toBeGreaterThan(ctxIdx);
  });
});

describe('multi-message chat batches', () => {
  // Regression guard for #2555: an outer `<messages>` envelope around
  // multiple chat messages caused the Claude Agent SDK to emit a synthetic
  // `No response requested.` stub instead of calling the API. Each
  // `<message>` block is self-contained; concatenating them is enough.
  it('does NOT wrap multiple chat messages in an outer <messages> envelope', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'one' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'two' });
    const result = formatMessages(getPendingMessages());
    expect(result).not.toContain('<messages>');
    expect(result).not.toContain('</messages>');
  });

  it('emits one <message> block per inbound row, in order', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'first' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'second' });
    insertMessage('m3', 'chat', { sender: 'Carol', text: 'third' });
    const result = formatMessages(getPendingMessages());
    const matches = result.match(/<message [^>]*>/g) ?? [];
    expect(matches.length).toBe(3);
    const firstIdx = result.indexOf('first');
    const secondIdx = result.indexOf('second');
    const thirdIdx = result.indexOf('third');
    expect(firstIdx).toBeGreaterThan(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);
  });
});

describe('slash command parsing', () => {
  it('matches /clear as an exact command, not an arbitrary prefix', () => {
    for (const text of ['/clear-all', '/clearfoo', '/clear/path', '/clear@']) {
      insertMessage(`m-${text}`, 'chat', { text });
      const message = getPendingMessages().at(-1);
      expect(message).toBeDefined();
      expect(isClearCommand(message!)).toBe(false);
    }
  });

  it('canonicalizes a Telegram-addressed /clear command', () => {
    insertMessage('m-clear-addressed', 'chat', { text: '/clear@NanoClawBot' });
    const message = getPendingMessages()[0]!;

    expect(categorizeMessage(message)).toMatchObject({ category: 'admin', command: '/clear' });
    expect(isClearCommand(message)).toBe(true);
  });
});

describe('durable agent task envelopes', () => {
  it('formats a bounded task assignment with correlation and tool instructions', () => {
    insertMessage('task-1', 'agent-task', {
      taskId: 'task-1',
      requesterAgentGroupId: 'requester',
      assigneeAgentGroupId: 'assignee',
      goal: 'Review <unsafe>',
      context: 'Focus on correctness',
      requiredCapabilities: ['repo.edit'],
      artifactPolicy: 'files',
      scope: 'agent-delegation',
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('<agent_task id="task-1" requester="requester"');
    expect(result).toContain('Review &lt;unsafe&gt;');
    expect(result).toContain('complete_agent_task');
  });

  it('formats correlated task events and cancellation', () => {
    insertMessage('event-1', 'agent-task-event', {
      taskId: 'task-1',
      eventSeq: 3,
      assigneeAgentGroupId: 'assignee',
      event: { type: 'progress', message: 'halfway' },
    });
    insertMessage('cancel-1', 'agent-task-cancel', { taskId: 'task-2' });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('<agent_task_event id="task-1" seq="3" type="progress"');
    expect(result).toContain('halfway');
    expect(result).toContain('<agent_task_cancel id="task-2"');
  });
});

describe('timestamp formatting', () => {
  it('renders time via formatLocalTime (user TZ)', () => {
    // 2026-06-15T12:00:00Z — timezone-agnostic assertions (year is stable)
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { timestamp: '2026-06-15T12:00:00.000Z' });
    const result = formatMessages(getPendingMessages());
    // formatLocalTime's format in en-US contains the year and a month abbrev
    expect(result).toContain('2026');
    expect(result).toMatch(/Jun/);
  });

  it('uses 12-hour AM/PM format', () => {
    // 15:30 UTC — some hour will show with AM or PM depending on TZ
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { timestamp: '2026-06-15T15:30:00.000Z' });
    const result = formatMessages(getPendingMessages());
    expect(result).toMatch(/(AM|PM)/);
  });
});

describe('reply_to + quoted_message rendering', () => {
  it('renders reply_to attribute and quoted_message when all fields present', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'Yes, on my way!',
      replyTo: { id: '42', sender: 'Bob', text: 'Are you coming tonight?' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('reply_to="42"');
    expect(result).toContain('<quoted_message from="Bob">Are you coming tonight?</quoted_message>');
    expect(result).toContain('Yes, on my way!</message>');
  });

  it('omits reply_to and quoted_message when no reply context', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'plain' });
    const result = formatMessages(getPendingMessages());
    expect(result).not.toContain('reply_to');
    expect(result).not.toContain('quoted_message');
  });

  it('renders reply_to but omits quoted_message when original content is missing', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'ack',
      replyTo: { id: '42', sender: 'Bob' }, // no text
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('reply_to="42"');
    expect(result).not.toContain('quoted_message');
  });

  it('XML-escapes reply context', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'reply',
      replyTo: { id: '1', sender: 'A & B', text: '<script>alert("xss")</script>' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('from="A &amp; B"');
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('&quot;xss&quot;');
  });
});

describe('XML escaping', () => {
  it('escapes <, >, &, " in sender and body', () => {
    insertMessage('m1', 'chat', {
      sender: 'A & B <Co>',
      text: '<script>alert("xss")</script>',
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
    expect(result).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });
});

describe('stripInternalTags', () => {
  it('strips single-line internal tags and trims', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe('hello  world');
  });

  it('strips multi-line internal tags', () => {
    expect(stripInternalTags('hello <internal>\nsecret\nstuff\n</internal> world')).toBe('hello  world');
  });

  it('strips multiple internal tag blocks', () => {
    expect(stripInternalTags('<internal>a</internal>hello<internal>b</internal>')).toBe('hello');
  });

  it('returns empty string when input is only internal tags', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });

  it('returns input unchanged when there are no internal tags', () => {
    expect(stripInternalTags('hello world')).toBe('hello world');
  });

  it('preserves content that surrounds internal tags', () => {
    expect(stripInternalTags('<internal>thinking</internal>The answer is 42')).toBe('The answer is 42');
  });
});

describe('taskFire gating (D3)', () => {
  // Regression for D3 (see docs/superpowers/specs/2026-07-28-ncl-tasks-...-design.md)
  // — one-door delivery must key off the HOST-STAMPED is_task flag, not the
  // message kind. Legacy series created before the ncl tasks port live in a chat
  // session; treating them as task fires makes their final text undeliverable
  // (delivery.ts drops a task_log row outside a task session).

  function seedRouting(routing: {
    channel_type: string | null;
    platform_id: string | null;
    thread_id: string | null;
    is_task: 0 | 1;
  }) {
    getInboundDb()
      .prepare(
        `INSERT INTO session_routing (id, channel_type, platform_id, thread_id, is_task)
         VALUES (1, ?, ?, ?, ?)`,
      )
      .run(routing.channel_type, routing.platform_id, routing.thread_id, routing.is_task);
  }

  function taskRow(id: string): MessageInRow {
    return {
      id,
      seq: null,
      kind: 'task',
      timestamp: new Date().toISOString(),
      status: 'pending',
      process_after: null,
      recurrence: null,
      tries: 0,
      trigger: 1,
      platform_id: null,
      channel_type: null,
      thread_id: null,
      content: JSON.stringify({ prompt: 'do the thing' }),
    };
  }

  function chatRow(id: string): MessageInRow {
    return {
      ...taskRow(id),
      kind: 'chat',
      content: JSON.stringify({ sender: 'Alice', text: 'hello' }),
    };
  }

  it('is not a task fire when the session is not stamped is_task, even for task rows', () => {
    seedRouting({ channel_type: 'telegram', platform_id: 'chat-1', thread_id: 'thread-1', is_task: 0 });
    expect(extractRouting([taskRow('t1'), taskRow('t2')]).taskFire).toBe(false);
  });

  it('is a task fire when the session is stamped is_task and every row is a task', () => {
    seedRouting({ channel_type: null, platform_id: null, thread_id: 'system:tasks:daily-1a2b', is_task: 1 });
    expect(extractRouting([taskRow('t1')]).taskFire).toBe(true);
  });

  it('is not a task fire when a chat row is mixed into a stamped task session', () => {
    seedRouting({ channel_type: null, platform_id: null, thread_id: 'system:tasks:daily-1a2b', is_task: 1 });
    expect(extractRouting([taskRow('t1'), chatRow('c1')]).taskFire).toBe(false);
  });

  it('is not a task fire for an empty batch', () => {
    seedRouting({ channel_type: null, platform_id: null, thread_id: 'system:tasks:daily-1a2b', is_task: 1 });
    expect(extractRouting([]).taskFire).toBe(false);
  });
});
