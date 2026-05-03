import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
