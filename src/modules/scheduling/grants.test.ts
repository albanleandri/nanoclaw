import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/schedule-admin-grants.js', () => ({
  getScheduleAdminGrants: (caller: string) =>
    ({
      'ag-none': [],
      'ag-one': [{ owner_agent_group_id: 'ag-owner' }],
      'ag-many': [{ owner_agent_group_id: 'ag-a' }, { owner_agent_group_id: 'ag-b' }],
    })[caller] ?? [],
  isScheduleAdminAuthorized: (caller: string, owner: string) =>
    (caller === 'ag-one' && owner === 'ag-owner') || (caller === 'ag-many' && (owner === 'ag-a' || owner === 'ag-b')),
}));

const { isTaskGroupAuthorized, resolveTaskGroup } = await import('./grants.js');

describe('resolveTaskGroup', () => {
  it('returns the caller group when nothing is requested and no grants exist', () => {
    expect(resolveTaskGroup('ag-none', undefined)).toBe('ag-none');
  });

  it('applies the sole grant as the default owner', () => {
    expect(resolveTaskGroup('ag-one', undefined)).toBe('ag-owner');
  });

  it('refuses to guess when several grants exist', () => {
    expect(() => resolveTaskGroup('ag-many', undefined)).toThrow('multiple schedule owners available');
  });

  it('accepts the caller own group explicitly, grant or not', () => {
    expect(resolveTaskGroup('ag-none', 'ag-none')).toBe('ag-none');
  });

  it('accepts an explicitly granted foreign group', () => {
    expect(resolveTaskGroup('ag-one', 'ag-owner')).toBe('ag-owner');
  });

  // Regression for D2 — the grant check is the only thing standing between a
  // group-scoped agent and another group's task rows.
  it('rejects an ungranted foreign group', () => {
    expect(() => resolveTaskGroup('ag-one', 'ag-stranger')).toThrow('schedule owner not authorized: ag-stranger');
  });
});

describe('isTaskGroupAuthorized', () => {
  it('is true for the caller own group and for a granted owner', () => {
    expect(isTaskGroupAuthorized('ag-one', 'ag-one')).toBe(true);
    expect(isTaskGroupAuthorized('ag-one', 'ag-owner')).toBe(true);
  });

  it('is false for an ungranted foreign group', () => {
    expect(isTaskGroupAuthorized('ag-one', 'ag-stranger')).toBe(false);
  });
});
