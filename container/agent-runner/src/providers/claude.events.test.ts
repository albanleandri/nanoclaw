import { describe, expect, it } from 'bun:test';

import { CLAUDE_SDK_DISALLOWED_TOOLS, classifyClaudeRateLimitEvent, translateClaudeSdkMessage } from './claude.js';

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

  it('classifies retry events and ignores informational rate-limit telemetry', () => {
    expect(translateClaudeSdkMessage({ type: 'system', subtype: 'api_retry' }).events[1]).toEqual({
      type: 'error',
      message: 'API retry',
      retryable: true,
    });
    expect(
      translateClaudeSdkMessage({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', utilization: 0.42 },
      }),
    ).toEqual({ events: [{ type: 'activity' }], acknowledgesTurn: false });
    expect(
      translateClaudeSdkMessage({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', utilization: 0.91 },
      }),
    ).toEqual({ events: [{ type: 'activity' }], acknowledgesTurn: false });
  });

  it('classifies rejected rate windows separately from exhausted credits', () => {
    expect(
      translateClaudeSdkMessage({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' },
      }).events[1],
    ).toEqual({
      type: 'error',
      message: 'Rate limit [five_hour]',
      retryable: false,
      classification: 'rate_limit',
    });
    expect(
      translateClaudeSdkMessage({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', errorCode: 'credits_required' },
      }).events[1],
    ).toEqual({ type: 'error', message: 'Out of credits', retryable: false, classification: 'quota' });
  });

  it('normalizes seconds and milliseconds in rate-limit reset timestamps', () => {
    const seconds = classifyClaudeRateLimitEvent({ status: 'rejected', resetsAt: 1_700_000_000 });
    const milliseconds = classifyClaudeRateLimitEvent({ status: 'rejected', resetsAt: 1_700_000_000_000 });
    expect(seconds).toEqual(milliseconds);
    expect(seconds?.message).toContain('2023-11-14T22:13:20.000Z');
  });

  it('recognizes both SDK credit-exhaustion signals', () => {
    expect(classifyClaudeRateLimitEvent({ status: 'rejected', errorCode: 'credits_required' })?.classification).toBe(
      'quota',
    );
    expect(
      classifyClaudeRateLimitEvent({ status: 'rejected', overageDisabledReason: 'out_of_credits' })?.classification,
    ).toBe('quota');
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
