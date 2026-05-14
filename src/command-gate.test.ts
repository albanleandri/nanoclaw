import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { createUser } from './modules/permissions/db/users.js';
import { grantRole } from './modules/permissions/db/user-roles.js';
import { gateCommand } from './command-gate.js';

function now() {
  return new Date().toISOString();
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
});

afterEach(() => {
  closeDb();
});

describe('gateCommand — non-slash messages', () => {
  it('passes plain text through', () => {
    expect(gateCommand('hello world', 'u-1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('passes JSON content with non-slash text', () => {
    const content = JSON.stringify({ text: 'hello there', sender: 'user' });
    expect(gateCommand(content, null, 'ag-1')).toEqual({ action: 'pass' });
  });

  it('passes empty content', () => {
    expect(gateCommand('', null, 'ag-1')).toEqual({ action: 'pass' });
  });
});

describe('gateCommand — filtered commands', () => {
  it.each(['/help', '/login', '/logout', '/doctor', '/config', '/remote-control'])(
    'filters %s silently',
    (cmd) => {
      expect(gateCommand(cmd, 'u-1', 'ag-1')).toEqual({ action: 'filter' });
    },
  );

  it('filters commands case-insensitively', () => {
    expect(gateCommand('/HELP', 'u-1', 'ag-1')).toEqual({ action: 'filter' });
    expect(gateCommand('/Login', 'u-1', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('filters commands with trailing args', () => {
    expect(gateCommand('/help me please', 'u-1', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('filters JSON-wrapped commands', () => {
    expect(gateCommand(JSON.stringify({ text: '/login' }), 'u-1', 'ag-1')).toEqual({
      action: 'filter',
    });
  });
});

describe('gateCommand — unknown slash commands', () => {
  it('passes unknown slash commands through to the agent', () => {
    expect(gateCommand('/memory', 'u-1', 'ag-1')).toEqual({ action: 'pass' });
    expect(gateCommand('/custom-thing', null, 'ag-1')).toEqual({ action: 'pass' });
  });
});

describe('gateCommand — admin commands, unauthenticated', () => {
  it('denies admin command when userId is null', () => {
    const result = gateCommand('/clear', null, 'ag-1');
    expect(result).toEqual({ action: 'deny', command: '/clear' });
  });

  it('denies admin command for a user with no role', () => {
    createUser({ id: 'u-noRole', kind: 'telegram', display_name: null, created_at: now() });
    const result = gateCommand('/compact', 'u-noRole', 'ag-1');
    expect(result).toEqual({ action: 'deny', command: '/compact' });
  });
});

describe('gateCommand — admin commands, owner', () => {
  beforeEach(() => {
    createUser({ id: 'u-owner', kind: 'telegram', display_name: null, created_at: now() });
    grantRole({ user_id: 'u-owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  });

  it.each(['/clear', '/compact', '/context', '/cost', '/files'])('passes %s for owner', (cmd) => {
    expect(gateCommand(cmd, 'u-owner', 'ag-1')).toEqual({ action: 'pass' });
  });
});

describe('gateCommand — admin commands, scoped admin', () => {
  beforeEach(() => {
    createUser({ id: 'u-admin', kind: 'telegram', display_name: null, created_at: now() });
    grantRole({ user_id: 'u-admin', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });
  });

  it('passes admin command for scoped admin of the group', () => {
    expect(gateCommand('/clear', 'u-admin', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('denies admin command for scoped admin of a different group', () => {
    createAgentGroup({ id: 'ag-2', name: 'Other', folder: 'other', agent_provider: null, created_at: now() });
    expect(gateCommand('/clear', 'u-admin', 'ag-2')).toEqual({ action: 'deny', command: '/clear' });
  });
});

describe('gateCommand — admin commands, global admin', () => {
  it('passes admin command for global admin across any group', () => {
    createUser({ id: 'u-ga', kind: 'telegram', display_name: null, created_at: now() });
    grantRole({ user_id: 'u-ga', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
    createAgentGroup({ id: 'ag-2', name: 'Other', folder: 'other', agent_provider: null, created_at: now() });

    expect(gateCommand('/compact', 'u-ga', 'ag-1')).toEqual({ action: 'pass' });
    expect(gateCommand('/compact', 'u-ga', 'ag-2')).toEqual({ action: 'pass' });
  });
});
