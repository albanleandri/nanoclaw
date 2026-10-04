import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('../../integrations/invoker.js', () => ({
  hostIntegrationInvoker: { invoke: mocks.invoke },
}));

vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: () => ({ cli_scope: 'group' }),
}));

import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import './family-agenda.js';

function agentContext(agentGroupId: string): CallerContext {
  return {
    caller: 'agent',
    sessionId: `session-${agentGroupId}`,
    agentGroupId,
    messagingGroupId: `messaging-${agentGroupId}`,
  };
}

describe('family agenda CLI resource', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({
      observed_at: '2026-10-04T10:00:00.000Z',
      profile: { id: 'profile-id', name: 'family-agenda' },
      adapter: { id: 'family-agenda', version: 1 },
      operation: 'agenda.read',
      data: {
        from: '2026-10-03',
        through: '2026-10-05',
        events: [
          {
            date: '2026-10-03',
            start: '12:00',
            end: '13:00',
            title: 'Repas',
            activity: 'Cantine',
            location: null,
            detail: null,
          },
        ],
      },
    });
  });

  it('invokes the fixed profile operation and preserves the versioned result envelope', async () => {
    const response = await dispatch(
      { id: 'show', command: 'family-agenda-show', args: { from: '2026-10-03', days: 3 } },
      agentContext('lumo'),
    );
    expect(response.ok).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith({
      caller: agentContext('lumo'),
      profile: 'family-agenda',
      operation: 'agenda.read',
      input: { from: '2026-10-03', days: 3 },
    });
    expect(response.ok ? response.data : undefined).toMatchObject({
      observed_at: '2026-10-04T10:00:00.000Z',
      adapter: { id: 'family-agenda', version: 1 },
      operation: 'agenda.read',
      data: { from: '2026-10-03', through: '2026-10-05' },
    });
    expect(response.ok ? response.human : undefined).toContain('12:00–13:00 — Repas (Cantine)');
  });

  it('returns authorization denial without an alternate credential path', async () => {
    mocks.invoke.mockRejectedValue(new Error('Integration is not available.'));
    const response = await dispatch(
      { id: 'show', command: 'family-agenda-show', args: { from: '2026-10-03' } },
      agentContext('other'),
    );
    expect(response).toMatchObject({ ok: false, error: { code: 'handler-error' } });
    expect(response.ok ? undefined : response.error.message).toBe('Integration is not available.');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it('forwards a host caller through the same fixed profile path', async () => {
    const response = await dispatch(
      { id: 'show', command: 'family-agenda-show', args: { from: '2026-10-03', days: 1 } },
      { caller: 'host' },
    );
    expect(response.ok).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith({
      caller: { caller: 'host' },
      profile: 'family-agenda',
      operation: 'agenda.read',
      input: { from: '2026-10-03', days: 1 },
    });
  });

  it('renders an empty normalized envelope as a successful empty agenda', async () => {
    mocks.invoke.mockResolvedValue({
      observed_at: '2026-10-04T10:00:00.000Z',
      profile: { id: 'profile-id', name: 'family-agenda' },
      adapter: { id: 'family-agenda', version: 1 },
      operation: 'agenda.read',
      data: { from: '2026-10-03', through: '2026-10-03', events: [] },
    });
    const response = await dispatch(
      { id: 'show', command: 'family-agenda-show', args: { from: '2026-10-03', days: 1 } },
      agentContext('lumo'),
    );
    expect(response).toMatchObject({
      ok: true,
      human: 'No family agenda events from 2026-10-03 through 2026-10-03.',
    });
  });

  it('rejects windows outside the declared limit', async () => {
    mocks.invoke.mockRejectedValue(new Error('Integration configuration is invalid.'));
    const response = await dispatch(
      { id: 'show', command: 'family-agenda-show', args: { from: '2026-10-03', days: 32 } },
      agentContext('lumo'),
    );
    expect(response).toMatchObject({ ok: false, error: { code: 'handler-error' } });
  });
});
