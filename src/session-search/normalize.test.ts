import { describe, expect, it } from 'vitest';

import { normalizeSessionText } from './normalize.js';

describe('session search normalization', () => {
  it('extracts bounded visible user and assistant text', () => {
    expect(
      normalizeSessionText({
        direction: 'inbound',
        kind: 'chat',
        content: JSON.stringify({ text: ' hello\\nworld ' }),
      }),
    ).toEqual({ role: 'user', text: 'hello\\nworld' });
    expect(
      normalizeSessionText({
        direction: 'outbound',
        kind: 'chat',
        channelType: 'telegram',
        content: JSON.stringify({ text: 'answer' }),
      }),
    ).toEqual({ role: 'assistant', text: 'answer' });
  });

  it('excludes system, agent, malformed, and attachment-only rows', () => {
    expect(
      normalizeSessionText({ direction: 'inbound', kind: 'system', content: '{"text":"secret"}' }),
    ).toBeUndefined();
    expect(
      normalizeSessionText({
        direction: 'outbound',
        kind: 'chat',
        channelType: 'agent',
        content: '{"text":"peer"}',
      }),
    ).toBeUndefined();
    expect(normalizeSessionText({ direction: 'inbound', kind: 'chat', content: '{' })).toBeUndefined();
    expect(
      normalizeSessionText({ direction: 'inbound', kind: 'chat', content: JSON.stringify({ files: ['a.pdf'] }) }),
    ).toBeUndefined();
  });
});
