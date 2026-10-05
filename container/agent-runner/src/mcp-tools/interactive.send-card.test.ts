// Ported from upstream b76fcb3d (#3426): the bridge drops every send_card
// action without a url, but the tool still promised buttons, so the agent
// blamed the platform — or faked an approval button with url "#".
import { describe, expect, it } from 'bun:test';

import { keepLinkActions } from './interactive.js';

describe('keepLinkActions', () => {
  it('keeps http(s) link actions and drops callback and placeholder actions', () => {
    const { card, dropped } = keepLinkActions({
      title: 'Report',
      actions: [
        { label: 'Open', url: 'https://example.com/report' },
        { label: 'Docs', url: 'HTTP://example.com' },
        { label: 'Approve', url: '#' },
        { label: 'Reject', id: 'reject' },
        { label: 'Mail', url: 'mailto:a@example.com' },
        { label: '', url: 'https://example.com' },
        { label: 'Bad', url: 'https://exa mple.com' },
        null,
      ],
    });
    expect(card.actions).toEqual([
      { label: 'Open', url: 'https://example.com/report' },
      { label: 'Docs', url: 'HTTP://example.com' },
    ]);
    expect(dropped).toBe(6);
  });

  it('leaves a card without actions untouched', () => {
    const input = { title: 'Plain' };
    expect(keepLinkActions(input)).toEqual({ card: input, dropped: 0 });
  });
});
