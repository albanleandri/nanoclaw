/**
 * Query options that the Claude Code 2.1.285 bump depends on (ported from
 * upstream ee0f0adf).
 *
 * - snapshot: false — since 2.1.267 Claude Code records the system prompt on a
 *   session's first request and resends it on every resume. The append is
 *   rebuilt per container start (and carries memory only on fresh sessions),
 *   so without this a resumed agent keeps stale instructions until compaction.
 * - claude.ai skill/plugin sync off — since 2.1.275 the operator's own
 *   claude.ai skills and plugins would otherwise load into every agent.
 * - TaskOutput is gone in 2.1.277; allowlisting it is dead configuration.
 */
import { describe, expect, it } from 'bun:test';
import type { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import { ClaudeProvider } from './claude.js';

async function captureOptions(continuation?: string): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const fakeQuery = ((args: { options?: Record<string, unknown> }) => {
    captured = args.options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
  }) as unknown as typeof sdkQuery;

  const provider = new ClaudeProvider({}, fakeQuery);
  const q = provider.query({
    prompt: 'hi',
    cwd: '/tmp',
    continuation,
    systemContext: { instructions: '# You are Ada' },
  });
  q.end();
  for await (const _ of q.events) {
    /* drain */
  }
  return captured!;
}

describe('Claude query options', () => {
  it('never records the system prompt, so a resume renders the current append', async () => {
    const options = await captureOptions('sess-earlier');
    expect(options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: '# You are Ada',
      snapshot: false,
    });
  });

  it('opts out of claude.ai skill and plugin sync', async () => {
    const options = await captureOptions();
    expect(options.settings).toEqual({ syncClaudeAiSkills: false, syncClaudeAiPlugins: false });
  });

  it('does not allowlist the removed TaskOutput tool', async () => {
    const options = await captureOptions();
    expect(options.allowedTools).not.toContain('TaskOutput');
    expect(options.allowedTools).toContain('TaskStop');
  });
});
