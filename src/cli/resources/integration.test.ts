import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, render } = vi.hoisted(() => ({ invoke: vi.fn(), render: vi.fn() }));

vi.mock('../../integrations/invocation-surface.js', () => ({ invokeGrantedHostIntegration: invoke }));
vi.mock('../../integrations/plugin.js', () => ({ renderHostIntegrationResult: render }));

import { GROUP_SCOPE_RESOURCES, lookup } from '../registry.js';
import './integration.js';

const caller = {
  caller: 'agent' as const,
  agentGroupId: 'synthetic-agent',
  sessionId: 'synthetic-session',
  messagingGroupId: 'synthetic-channel',
};

describe('generic host integration invocation resource', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is group-scoped while administration remains separate', () => {
    expect(GROUP_SCOPE_RESOURCES.has('integration')).toBe(true);
    expect(GROUP_SCOPE_RESOURCES.has('integrations')).toBe(false);
    expect(lookup('integration-invoke')?.access).toBe('open');
  });

  it('passes only adapter/version/operation/profile/input plus trusted caller context', async () => {
    const command = lookup('integration-invoke')!;
    const parsed = command.parseArgs({
      adapter: 'records',
      'adapter-version': '1',
      operation: 'records.read',
      input: '{"limit":10}',
    });
    invoke.mockResolvedValue({ adapter: { id: 'records', version: 1 }, operation: 'records.read', data: [] });
    await command.handler(parsed, caller);
    expect(invoke).toHaveBeenCalledWith({
      caller,
      adapterId: 'records',
      adapterVersion: 1,
      operation: 'records.read',
      profile: undefined,
      input: { limit: 10 },
    });
  });

  it('uses the plugin-owned renderer only for human mode', () => {
    const command = lookup('integration-invoke')!;
    const envelope = { adapter: { id: 'records', version: 1 }, operation: 'records.read', data: { ok: true } };
    render.mockReturnValue('rendered');
    expect(command.formatHuman?.(envelope)).toBe('rendered');
    expect(render).toHaveBeenCalledWith(envelope);
  });

  it('rejects arbitrary undeclared flags such as URLs and methods', () => {
    const command = lookup('integration-invoke')!;
    expect(() =>
      command.parseArgs({
        adapter: 'records',
        'adapter-version': 1,
        operation: 'records.read',
        url: 'https://example.test',
      }),
    ).toThrow(/unknown flag --url/);
  });
});
