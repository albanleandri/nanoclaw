import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadCredential: vi.fn(),
  fetchAgenda: vi.fn(),
}));

vi.mock('../../integrations/family-agenda.js', () => ({
  loadFamilyAgendaCredential: mocks.loadCredential,
  fetchFamilyAgenda: mocks.fetchAgenda,
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
    mocks.loadCredential.mockReset();
    mocks.fetchAgenda.mockReset();
    mocks.loadCredential.mockReturnValue({
      username: 'parent',
      password: 'secret',
      agentGroupId: 'lumo',
      tenant: 'example-town',
      personId: '3',
    });
    mocks.fetchAgenda.mockResolvedValue({
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
    });
  });

  it('returns normalized data to the configured agent only', async () => {
    const response = await dispatch(
      { id: 'show', command: 'family-agenda-show', args: { from: '2026-10-03', days: 3 } },
      agentContext('lumo'),
    );
    expect(response.ok).toBe(true);
    expect(mocks.fetchAgenda).toHaveBeenCalledWith(expect.objectContaining({ password: 'secret' }), {
      from: '2026-10-03',
      days: 3,
    });
    expect(response.ok ? response.data : undefined).not.toHaveProperty('password');
  });

  it('rejects every other agent group before fetching the portal', async () => {
    const response = await dispatch(
      { id: 'show', command: 'family-agenda-show', args: { from: '2026-10-03' } },
      agentContext('other'),
    );
    expect(response).toMatchObject({ ok: false, error: { code: 'handler-error' } });
    expect(mocks.fetchAgenda).not.toHaveBeenCalled();
  });

  it('rejects windows outside the declared limit', async () => {
    mocks.fetchAgenda.mockRejectedValue(new Error('--days must be an integer between 1 and 31'));
    const response = await dispatch(
      { id: 'show', command: 'family-agenda-show', args: { from: '2026-10-03', days: 32 } },
      agentContext('lumo'),
    );
    expect(response).toMatchObject({ ok: false, error: { code: 'handler-error' } });
  });
});
