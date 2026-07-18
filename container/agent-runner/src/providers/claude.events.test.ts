import { describe, expect, it } from 'bun:test';

import { CLAUDE_SDK_DISALLOWED_TOOLS, translateClaudeSdkMessage } from './claude.js';

describe('Claude SDK tool surface', () => {
  it('excludes desktop-only reporting tools in the headless runner', () => {
    expect(CLAUDE_SDK_DISALLOWED_TOOLS).toContain('DesignSync');
    expect(CLAUDE_SDK_DISALLOWED_TOOLS).toContain('ReportFindings');
  });
});

describe('Claude SDK event translation', () => {
  it('normalizes init and result events while preserving activity', () => {
    expect(translateClaudeSdkMessage({ type: 'system', subtype: 'init', session_id: 'session-1' })).toEqual({
      events: [{ type: 'activity' }, { type: 'init', continuation: 'session-1' }],
      acknowledgesTurn: false,
    });
    const result = translateClaudeSdkMessage({
      type: 'result',
      result: 'done',
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    expect(result.acknowledgesTurn).toBe(true);
    expect(result.events[1]).toMatchObject({
      type: 'result',
      text: 'done',
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });

  it('classifies retry and quota events', () => {
    expect(translateClaudeSdkMessage({ type: 'system', subtype: 'api_retry' }).events[1]).toEqual({
      type: 'error',
      message: 'API retry',
      retryable: true,
    });
    expect(translateClaudeSdkMessage({ type: 'system', subtype: 'rate_limit_event' }).events[1]).toEqual({
      type: 'error',
      message: 'Rate limit',
      retryable: false,
      classification: 'quota',
    });
  });

  it('keeps compaction as activity metadata and translates task progress', () => {
    expect(
      translateClaudeSdkMessage({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { pre_tokens: 1234 },
      }),
    ).toEqual({ events: [{ type: 'activity' }], acknowledgesTurn: false });
    expect(
      translateClaudeSdkMessage({ type: 'system', subtype: 'task_notification', summary: 'Worker done' }).events[1],
    ).toEqual({ type: 'progress', message: 'Worker done' });
  });
});
