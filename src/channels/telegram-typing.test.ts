import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendTelegramTyping } from './telegram.js';

const fetchMock = vi.fn();

afterEach(() => {
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

describe('sendTelegramTyping', () => {
  it('sends Telegram typing chat action for a platform id', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await sendTelegramTyping('token-123', 'telegram:12345');

    expect(fetchMock).toHaveBeenCalledWith('https://api.telegram.org/bottoken-123/sendChatAction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: '12345', action: 'typing' }),
    });
  });

  it('preserves negative group chat ids', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await sendTelegramTyping('token-123', 'telegram:-10012345');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ chat_id: '-10012345', action: 'typing' });
  });

  it('skips malformed platform ids', async () => {
    vi.stubGlobal('fetch', fetchMock);

    await sendTelegramTyping('token-123', 'telegram:');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
