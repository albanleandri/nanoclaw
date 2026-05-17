import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sanitizeTelegramText, splitAtBoundary } from './telegram.js';

// vi.hoisted runs before vi.mock factories, making createdApis available inside the factory
const { createdApis } = vi.hoisted(() => {
  type MockApiInstance = {
    token: string;
    sendMessage: ReturnType<typeof vi.fn>;
    setMyName: ReturnType<typeof vi.fn>;
    getMe: ReturnType<typeof vi.fn>;
  };
  const createdApis: MockApiInstance[] = [];
  return { createdApis };
});

// Regular function (not arrow) so `new Api(token)` works as a constructor
vi.mock('grammy', () => {
  function Api(this: Record<string, unknown>, token: string) {
    this.token = token;
    this.sendMessage = vi.fn().mockResolvedValue({});
    this.setMyName = vi.fn().mockResolvedValue({});
    this.getMe = vi.fn().mockResolvedValue({ username: `bot_${token}`, id: 1 });
    createdApis.push(this as (typeof createdApis)[number]);
  }
  return { Api, Bot: function () {} };
});

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'TestBot',
  TRIGGER_PATTERN: /test/,
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({}),
}));

vi.mock('./registry.js', () => ({
  registerChannel: vi.fn(),
}));

type SendPoolMessage = (
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
  pinnedIndex?: number,
) => Promise<void>;
type InitBotPool = (tokens: string[]) => Promise<void>;

describe('sendPoolMessage', () => {
  let sendPoolMessage: SendPoolMessage;
  let initBotPool: InitBotPool;

  beforeEach(async () => {
    vi.useFakeTimers();
    createdApis.length = 0;
    vi.resetModules();
    const mod = await import('./telegram.js');
    sendPoolMessage = mod.sendPoolMessage;
    initBotPool = mod.initBotPool;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Flushes the 2-second bot-rename timer that fires on first sender assignment
  async function send(
    chatId: string,
    text: string,
    sender: string,
    groupFolder: string,
    pinnedIndex?: number,
  ): Promise<void> {
    const p = sendPoolMessage(chatId, text, sender, groupFolder, pinnedIndex);
    await vi.runAllTimersAsync();
    return p;
  }

  it('returns without sending when pool is empty', async () => {
    await send('tg:123', 'hello', 'Alice', 'group1');
    expect(createdApis).toHaveLength(0);
  });

  it('assigns bots round-robin to different first-time senders', async () => {
    await initBotPool(['tok0', 'tok1', 'tok2']);
    await send('tg:123', 'hi', 'Alice', 'grp');
    await send('tg:123', 'hi', 'Bob', 'grp');
    await send('tg:123', 'hi', 'Carol', 'grp');
    expect(createdApis[0].sendMessage).toHaveBeenCalledTimes(1);
    expect(createdApis[1].sendMessage).toHaveBeenCalledTimes(1);
    expect(createdApis[2].sendMessage).toHaveBeenCalledTimes(1);
  });

  it('pins the sender to the specified bot index', async () => {
    await initBotPool(['tok0', 'tok1', 'tok2']);
    await send('tg:123', 'hi', 'Alice', 'grp', 2);
    expect(createdApis[2].sendMessage).toHaveBeenCalledTimes(1);
    expect(createdApis[0].sendMessage).not.toHaveBeenCalled();
    expect(createdApis[1].sendMessage).not.toHaveBeenCalled();
  });

  it('does not advance the round-robin counter when pinnedIndex is used', async () => {
    await initBotPool(['tok0', 'tok1', 'tok2']);
    // Two pinned senders — nextPoolIndex stays at 0
    await send('tg:123', 'hi', 'Alice', 'grp', 0);
    await send('tg:123', 'hi', 'Bob', 'grp', 1);
    // First unpinned sender should get bot 0 (nextPoolIndex % 3 = 0)
    await send('tg:123', 'hi', 'Carol', 'grp');
    expect(createdApis[0].sendMessage).toHaveBeenCalledTimes(2); // Alice + Carol
    expect(createdApis[1].sendMessage).toHaveBeenCalledTimes(1); // Bob
    expect(createdApis[2].sendMessage).not.toHaveBeenCalled();
  });

  it('clamps out-of-range pinnedIndex via modulo', async () => {
    await initBotPool(['tok0', 'tok1', 'tok2']);
    await send('tg:123', 'hi', 'Alice', 'grp', 5); // 5 % 3 = 2
    expect(createdApis[2].sendMessage).toHaveBeenCalledTimes(1);
    expect(createdApis[0].sendMessage).not.toHaveBeenCalled();
    expect(createdApis[1].sendMessage).not.toHaveBeenCalled();
  });

  it('routes all messages from the same sender to the same bot', async () => {
    await initBotPool(['tok0', 'tok1']);
    await send('tg:123', 'msg1', 'Alice', 'grp');
    await send('tg:123', 'msg2', 'Alice', 'grp');
    await send('tg:123', 'msg3', 'Alice', 'grp');
    const totalCalls = createdApis.reduce(
      (sum, api) => sum + (api.sendMessage.mock.calls.length as number),
      0,
    );
    expect(totalCalls).toBe(3);
    const botWithAll = createdApis.find(
      (api) => api.sendMessage.mock.calls.length === 3,
    );
    expect(botWithAll).toBeDefined();
  });

  it('isolates sender assignments by groupFolder', async () => {
    await initBotPool(['tok0', 'tok1', 'tok2']);
    // Same sender name in different groups → independent round-robin entries
    await send('tg:111', 'hi', 'Alice', 'group-a');
    await send('tg:222', 'hi', 'Alice', 'group-b');
    expect(createdApis[0].sendMessage).toHaveBeenCalledTimes(1);
    expect(createdApis[1].sendMessage).toHaveBeenCalledTimes(1);
    expect(createdApis[2].sendMessage).not.toHaveBeenCalled();
  });

  it('calls setMyName on the first send from a new sender', async () => {
    await initBotPool(['tok0']);
    await send('tg:123', 'hi', 'Alice', 'grp');
    expect(createdApis[0].setMyName).toHaveBeenCalledWith('Alice');
  });

  it('does not call setMyName again on subsequent sends from the same sender', async () => {
    await initBotPool(['tok0']);
    await send('tg:123', 'msg1', 'Alice', 'grp');
    await send('tg:123', 'msg2', 'Alice', 'grp');
    expect(createdApis[0].setMyName).toHaveBeenCalledTimes(1);
  });
});

describe('sanitizeTelegramText', () => {
  it('converts double-asterisk bold to single-asterisk', () => {
    expect(sanitizeTelegramText('**bold**')).toBe('*bold*');
  });

  it('converts double-underscore italic to single-underscore', () => {
    expect(sanitizeTelegramText('__italic__')).toBe('_italic_');
  });

  it('strips ## header prefixes leaving the text', () => {
    expect(sanitizeTelegramText('## Header')).toBe('Header');
  });

  it('strips ### and deeper header prefixes', () => {
    expect(sanitizeTelegramText('### Deep header')).toBe('Deep header');
  });

  it('removes --- horizontal rule lines entirely', () => {
    expect(sanitizeTelegramText('before\n---\nafter')).toBe('before\nafter');
  });

  it('strips code fence markers preserving the content inside', () => {
    expect(sanitizeTelegramText('```\ncode here\n```')).toBe('code here\n');
  });

  it('strips language-tagged code fence openers', () => {
    expect(sanitizeTelegramText('```python\nprint("hi")\n```')).toBe(
      'print("hi")\n',
    );
  });

  it('collapses 3 consecutive blank lines to 2', () => {
    expect(sanitizeTelegramText('a\n\n\n\nb')).toBe('a\n\n\nb');
  });

  it('collapses 4 consecutive blank lines to 2', () => {
    expect(sanitizeTelegramText('a\n\n\n\n\nb')).toBe('a\n\n\nb');
  });

  it('leaves 1 and 2 consecutive blank lines unchanged', () => {
    expect(sanitizeTelegramText('a\n\nb')).toBe('a\n\nb');
    expect(sanitizeTelegramText('a\n\n\nb')).toBe('a\n\n\nb');
  });

  it('handles combined patterns in one pass', () => {
    const input = '## Title\n**bold** and __italic__\n---\n```\ncode\n```';
    const expected = 'Title\n*bold* and _italic_\ncode\n';
    expect(sanitizeTelegramText(input)).toBe(expected);
  });

  it('returns plain text unchanged', () => {
    expect(sanitizeTelegramText('hello world')).toBe('hello world');
  });
});

describe('splitAtBoundary', () => {
  it('returns the text as single element when under the limit', () => {
    expect(splitAtBoundary('hello world', 100)).toEqual(['hello world']);
  });

  it('returns the text as single element when exactly at the limit', () => {
    const text = 'a'.repeat(100);
    expect(splitAtBoundary(text, 100)).toEqual([text]);
  });

  it('splits at a paragraph boundary (\\n\\n) before the limit', () => {
    const part1 = 'a'.repeat(3000) + '\n\n';
    const part2 = 'b'.repeat(2000);
    expect(splitAtBoundary(part1 + part2, 4096)).toEqual([part1, part2]);
  });

  it('splits at a line boundary (\\n) when no paragraph break fits before the limit', () => {
    const part1 = 'a'.repeat(3000) + '\n';
    const part2 = 'b'.repeat(2000); // no \n\n anywhere
    expect(splitAtBoundary(part1 + part2, 4096)).toEqual([part1, part2]);
  });

  it('splits at a word boundary (space) when no newline fits before the limit', () => {
    const part1 = 'a'.repeat(3000) + ' ';
    const part2 = 'b'.repeat(2000);
    expect(splitAtBoundary(part1 + part2, 4096)).toEqual([part1, part2]);
  });

  it('falls back to hard character split when no boundary exists in the window', () => {
    const text = 'a'.repeat(5000);
    expect(splitAtBoundary(text, 4096)).toEqual([
      'a'.repeat(4096),
      'a'.repeat(904),
    ]);
  });

  it('produces multiple chunks when text requires more than one split', () => {
    // part1 = 3002 chars; part2 = 4002 chars; part3 = 500 chars
    // After first split: remaining = part2+part3 = 4502 > 4096 → needs second split
    const part1 = 'a'.repeat(3000) + '\n\n';
    const part2 = 'b'.repeat(4000) + '\n\n';
    const part3 = 'c'.repeat(500);
    const result = splitAtBoundary(part1 + part2 + part3, 4096);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(part1);
    expect(result[1]).toBe(part2);
    expect(result[2]).toBe(part3);
  });

  it('never produces a chunk exceeding the limit', () => {
    // Simulate a real long report with paragraph breaks scattered throughout
    const text =
      'Intro paragraph.\n\n' +
      'x'.repeat(3800) +
      '\n\nSection two content.\n\n' +
      'y'.repeat(3600) +
      '\n\nFinal section.';
    const chunks = splitAtBoundary(text, 4096);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it('rejoining chunks reconstructs the original text exactly', () => {
    const original =
      'First part.\n\n' +
      'x'.repeat(3800) +
      '\n\nSecond part.\n\n' +
      'y'.repeat(1000);
    const chunks = splitAtBoundary(original, 4096);
    expect(chunks.join('')).toBe(original);
  });
});

describe('TelegramChannel.sendPoll', () => {
  function makeBotApi() {
    return {
      sendPoll: vi.fn().mockResolvedValue({
        poll: { id: 'poll-abc' },
        message_id: 10,
      }),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      sendChatAction: vi.fn().mockResolvedValue({}),
    };
  }

  function makeMockBot(api: ReturnType<typeof makeBotApi>) {
    const handlers = new Map<string, (ctx: unknown) => void>();
    return {
      api,
      on: vi.fn((event: string, handler: (ctx: unknown) => void) => {
        handlers.set(event, handler);
      }),
      command: vi.fn(),
      catch: vi.fn(),
      start: vi.fn(
        ({
          onStart,
        }: {
          onStart: (info: { username: string; id: number }) => void;
        }) => {
          onStart({ username: 'testbot', id: 1 });
          return Promise.resolve();
        },
      ),
      stop: vi.fn(),
      _handlers: handlers,
    };
  }

  it('calls api.sendPoll with correct parameters for multiple-choice', async () => {
    const api = makeBotApi();
    const mockBot = makeMockBot(api);

    vi.resetModules();
    vi.doMock('grammy', () => {
      function Api(this: Record<string, unknown>, token: string) {
        this.token = token;
        this.sendMessage = vi.fn().mockResolvedValue({});
        this.setMyName = vi.fn().mockResolvedValue({});
        this.getMe = vi
          .fn()
          .mockResolvedValue({ username: `bot_${token}`, id: 1 });
      }
      function BotMock(this: Record<string, unknown>) {
        Object.assign(this, mockBot);
      }
      return {
        Api,
        Bot: BotMock,
        InlineKeyboard: class InlineKeyboard {
          text() {
            return this;
          }
          row() {
            return this;
          }
        },
      };
    });
    const { TelegramChannel } = await import('./telegram.js');

    const channel = new TelegramChannel('test-token', {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    await channel.connect();

    await (channel as any).sendPoll(
      'tg:123',
      'Which tiers?',
      ['Large Cap', 'Mid Cap'],
      true,
    );

    expect(api.sendPoll).toHaveBeenCalledWith(
      '123',
      'Which tiers?',
      [{ text: 'Large Cap' }, { text: 'Mid Cap' }],
      { is_anonymous: false, allows_multiple_answers: true },
    );
    const pending = (channel as any).pendingPolls as Map<
      string,
      { chatJid: string; options: string[] }
    >;
    expect(pending.get('poll-abc')).toEqual({
      chatJid: 'tg:123',
      options: ['Large Cap', 'Mid Cap'],
    });
  });

  it('calls api.sendMessage with InlineKeyboard for single-choice', async () => {
    const api = makeBotApi();
    const mockBot = makeMockBot(api);

    vi.resetModules();
    vi.doMock('grammy', () => {
      function Api(this: Record<string, unknown>, token: string) {
        this.token = token;
        this.sendMessage = vi.fn().mockResolvedValue({});
        this.setMyName = vi.fn().mockResolvedValue({});
        this.getMe = vi
          .fn()
          .mockResolvedValue({ username: `bot_${token}`, id: 1 });
      }
      function BotMock(this: Record<string, unknown>) {
        Object.assign(this, mockBot);
      }
      return {
        Api,
        Bot: BotMock,
        InlineKeyboard: class InlineKeyboard {
          text() {
            return this;
          }
          row() {
            return this;
          }
        },
      };
    });
    const { TelegramChannel } = await import('./telegram.js');

    const channel = new TelegramChannel('test-token', {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    await channel.connect();

    await (channel as any).sendPoll('tg:456', 'Proceed?', ['Yes', 'No'], false);

    expect(api.sendMessage).toHaveBeenCalledWith(
      '456',
      'Proceed?',
      expect.objectContaining({ reply_markup: expect.any(Object) }),
    );
    const pending = (channel as any).pendingKeyboards as Map<
      number,
      { chatJid: string }
    >;
    expect(pending.get(42)).toEqual({ chatJid: 'tg:456' });
  });
});
