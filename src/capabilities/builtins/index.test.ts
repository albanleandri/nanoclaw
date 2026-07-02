import { describe, expect, it } from 'vitest';

import { getCapability } from '../capability-registry.js';
import './index.js';

describe('built-in capabilities', () => {
  it('registers runtime-required host actions', () => {
    expect(getCapability('nanoclaw.send-message')?.adapters[0].kind).toBe('host-action');
    expect(getCapability('nanoclaw.schedule-task')?.adapters[0].kind).toBe('host-action');
    expect(getCapability('nanoclaw.send-message')?.adapters).toContainEqual(
      expect.objectContaining({ kind: 'protocol-tool', entrypoint: 'tool:send_message' }),
    );
    expect(getCapability('nanoclaw.schedule-task')?.adapters).toContainEqual(
      expect.objectContaining({ kind: 'protocol-tool', entrypoint: 'tool:schedule_task' }),
    );
  });

  it('scopes browser MCP to tool-capable core runtimes', () => {
    const adapter = getCapability('web.browse')?.adapters.find((item) => item.kind === 'mcp');
    expect(adapter?.runtimeIds).toEqual(expect.arrayContaining(['claude-sdk', 'codex-app-server']));
    expect(adapter?.availabilityCheck).toBe('mcp-server-configured');
  });

  it('requires a writable workspace for repository editing', () => {
    expect(getCapability('repo.edit')?.requirements.workspace).toBe('write');
  });

  it('keeps arbitrary RTK shell execution on the native container runtimes', () => {
    const capability = getCapability('runtime.shell');
    expect(capability?.adapters).toEqual([
      expect.objectContaining({
        kind: 'mcp',
        runtimeIds: ['claude-sdk', 'codex-app-server'],
        entrypoint: 'mcp:nanoclaw',
      }),
    ]);
  });
});
