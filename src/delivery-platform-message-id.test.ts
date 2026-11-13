/**
 * Inbound rows carry a `:<agent group id>` suffix; reactions and edits must
 * reach the platform with the bare platform message id.
 */
import { describe, expect, it } from 'vitest';

import { withPlatformMessageId } from './delivery.js';

const agentGroupId = 'ag-1700000000000-abc123';

function normalize(content: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(withPlatformMessageId(content, JSON.stringify(content), agentGroupId));
}

describe('withPlatformMessageId', () => {
  it('strips the agent-group suffix from reaction and edit targets', () => {
    expect(normalize({ operation: 'reaction', messageId: `-1001234567890:449:${agentGroupId}`, emoji: '👍' })).toEqual({
      operation: 'reaction',
      messageId: '-1001234567890:449',
      emoji: '👍',
    });
    expect(normalize({ operation: 'edit', messageId: `449:${agentGroupId}`, text: 'fixed' })).toEqual({
      operation: 'edit',
      messageId: '449',
      text: 'fixed',
    });
  });

  it('leaves ids without this agent-group suffix alone', () => {
    const content = { operation: 'reaction', messageId: '-1001234567890:449', emoji: '❤️' };
    expect(normalize(content)).toEqual(content);
  });

  it('leaves ordinary chat messages byte-identical', () => {
    const raw = JSON.stringify({ text: `hello :${agentGroupId}` });
    expect(withPlatformMessageId(JSON.parse(raw), raw, agentGroupId)).toBe(raw);
  });
});
