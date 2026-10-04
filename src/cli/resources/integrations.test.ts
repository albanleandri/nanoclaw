import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { CallerContext } from '../frame.js';
import { GROUP_SCOPE_RESOURCES, listCommands, lookup } from '../registry.js';
import './integrations.js';

const agent: CallerContext = {
  caller: 'agent',
  sessionId: 'session-1',
  agentGroupId: 'group-1',
  messagingGroupId: 'messaging-1',
};

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(closeDb);

describe('integrations CLI resource', () => {
  it('is excluded from group scope and every management handler explicitly rejects agents', async () => {
    expect(GROUP_SCOPE_RESOURCES.has('integrations')).toBe(false);
    const commands = listCommands().filter((command) => command.resource === 'integrations');
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command.access).toBe('hidden');
      await expect(command.handler({}, agent)).rejects.toThrow(/only to the host operator/);
    }
  });

  it('keeps credential management out of the approval path', () => {
    expect(lookup('integrations-credential-set')?.access).toBe('hidden');
    expect(lookup('integrations-credential-rotate')?.access).toBe('hidden');
    expect(lookup('integrations-credential-revoke')?.access).toBe('hidden');
  });

  it('allows a host operator to list the empty dormant registry state', async () => {
    const command = lookup('integrations-list');
    await expect(command?.handler({}, { caller: 'host' })).resolves.toEqual([]);
  });
});
