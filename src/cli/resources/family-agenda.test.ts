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
    expect(response.ok ? response.human : undefined).toBe(
      [
        '📅 **Family agenda · 3–5 Oct 2026**',
        '',
        '**Sat 3 Oct**',
        '• 🕒 12:00–13:00 · Repas · Cantine',
        '',
        '**Mon 5 Oct**',
        '• Nothing scheduled',
      ].join('\n'),
    );
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
      human: '📅 **Family agenda · 3 Oct 2026**\n\n• Nothing scheduled in this window',
    });
  });

  it('renders a compact long-window Telegram view without merging distinct bookings', async () => {
    const standardDay = (date: string) => [
      {
        date,
        start: null,
        end: null,
        title: '16h30-17h30-Résa',
        activity: 'Periscolaire VLG',
        location: 'ECOLE MATERNELLE DES POTTIERES',
        detail: 'Réservation Peri soir 16h30-17h30 Post Facturation',
      },
      {
        date,
        start: null,
        end: null,
        title: '18h30-Résa',
        activity: 'Periscolaire VLG',
        location: 'ECOLE MATERNELLE DES POTTIERES',
        detail: 'Réservation Peri soir 17h30-18h30 Post Facturation',
      },
      {
        date,
        start: null,
        end: null,
        title: 'Classique-Résa',
        activity: 'Restauration scolaire VLG',
        location: 'ECOLE MATERNELLE DES POTTIERES',
        detail: 'Réservation Restauration menu classique Post Facturation',
      },
    ];
    mocks.invoke.mockResolvedValue({
      observed_at: '2026-10-04T10:00:00.000Z',
      profile: { id: 'profile-id', name: 'family-agenda' },
      adapter: { id: 'family-agenda', version: 1 },
      operation: 'agenda.read',
      data: {
        from: '2026-10-04',
        through: '2026-10-31',
        events: [
          ...standardDay('2026-10-05'),
          ...standardDay('2026-10-06'),
          {
            date: '2026-10-14',
            start: null,
            end: null,
            title: 'Matin-Résa',
            activity: 'Accueils de loisirs VLG',
            location: 'ECOLE MATERNELLE DES POTTIERES',
            detail: 'Réservation Matin Post Facturation',
          },
          {
            date: '2026-10-14',
            start: null,
            end: null,
            title: 'Menu classique-Résa',
            activity: 'Accueils de loisirs VLG',
            location: 'ECOLE MATERNELLE DES POTTIERES',
            detail: 'Réservation Restauration menu classique Post Facturation',
          },
          {
            date: '2026-10-14',
            start: null,
            end: null,
            title: 'Après-Midi-Résa',
            activity: 'Accueils de loisirs VLG',
            location: 'ECOLE MATERNELLE DES POTTIERES',
            detail: 'Réservation Après-Midi Post Facturation',
          },
        ],
      },
    });

    const response = await dispatch(
      { id: 'show', command: 'family-agenda-show', args: { from: '2026-10-04', days: 28 } },
      agentContext('lumo'),
    );

    expect(response.ok).toBe(true);
    const human = response.ok ? response.human : undefined;
    expect(human).toBe(
      [
        '📅 **Family agenda · 4–31 Oct 2026**',
        '📍 Ecole Maternelle des Pottieres',
        '',
        '**Week of 5 Oct**',
        '',
        '**Mon 5 · Tue 6**',
        '• 🍽 Canteen · classic menu',
        '• 🕒 16:30–17:30 · After-school care',
        '• 🕒 17:30–18:30 · After-school care',
        '',
        '**Week of 12 Oct**',
        '',
        '**Wed 14**',
        '• Morning · Leisure centre',
        '• 🍽 Leisure centre lunch · classic menu',
        '• Afternoon · Leisure centre',
      ].join('\n'),
    );
    expect(human).not.toContain('All day');
    expect(human).not.toContain('16:30–18:30');
    expect(human).not.toMatch(/holiday|vacation/i);
  });

  it('keeps differing locations on their events and neutralizes Markdown from upstream text', async () => {
    mocks.invoke.mockResolvedValue({
      observed_at: '2026-10-04T10:00:00.000Z',
      profile: { id: 'profile-id', name: 'family-agenda' },
      adapter: { id: 'family-agenda', version: 1 },
      operation: 'agenda.read',
      data: {
        from: '2026-10-05',
        through: '2026-10-06',
        events: [
          {
            date: '2026-10-05',
            start: null,
            end: null,
            title: '**Bring [note]**',
            activity: null,
            location: 'Site_A',
            detail: null,
          },
          {
            date: '2026-10-06',
            start: null,
            end: null,
            title: 'Visit',
            activity: null,
            location: 'Site B',
            detail: null,
          },
        ],
      },
    });

    const response = await dispatch(
      { id: 'show', command: 'family-agenda-show', args: { from: '2026-10-05', days: 2 } },
      agentContext('lumo'),
    );
    const human = response.ok ? response.human : '';
    expect(human).toContain('• Bring note · Site A');
    expect(human).toContain('• Visit · Site B');
    expect(human).not.toContain('**Bring');
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
