import { describe, expect, it } from 'bun:test';
import type { SessionStartHookInput } from '@anthropic-ai/claude-agent-sdk';

import { createClaudeSystemAppend, createMemorySessionStartHook } from './claude.js';

function input(source: SessionStartHookInput['source']): SessionStartHookInput {
  return {
    hook_event_name: 'SessionStart',
    source,
    session_id: 'session-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/workspace/agent',
  };
}

describe('Claude neutral-memory SessionStart hook', () => {
  it('injects freshly rendered memory at startup, clear, and compact boundaries', async () => {
    let renders = 0;
    const hook = createMemorySessionStartHook(() => `memory-${++renders}`);
    const options = { signal: new AbortController().signal };

    for (const [index, source] of (['startup', 'clear', 'compact'] as const).entries()) {
      await expect(hook(input(source), undefined, options)).resolves.toMatchObject({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `memory-${index + 1}`,
        },
      });
    }
    expect(renders).toBe(3);
  });

  it('returns no context and does not render when resuming', async () => {
    let renders = 0;
    const hook = createMemorySessionStartHook(() => {
      renders += 1;
      return 'memory';
    });

    await expect(hook(input('resume'), undefined, { signal: new AbortController().signal })).resolves.toEqual({});
    expect(renders).toBe(0);
  });

  it('backs up delivery in the system append for new sessions but not resumes', () => {
    let renders = 0;
    const memory = {
      enabled: true,
      render: () => `memory-${++renders}`,
    };

    expect(createClaudeSystemAppend('instructions', undefined, memory)).toBe('instructions\n\nmemory-1');
    expect(createClaudeSystemAppend('instructions', 'existing-session', memory)).toBe('instructions');
    expect(renders).toBe(1);
  });
});
