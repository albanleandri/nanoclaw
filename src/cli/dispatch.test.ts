import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockGetContainerConfig = vi.fn();
vi.mock('../db/container-configs.js', () => ({
  getContainerConfig: (...args: unknown[]) => mockGetContainerConfig(...args),
}));

const mockGetAgentGroup = vi.fn();
vi.mock('../db/agent-groups.js', () => ({
  getAgentGroup: (...args: unknown[]) => mockGetAgentGroup(...args),
}));

const mockGetSession = vi.fn();
vi.mock('../db/sessions.js', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

// dispatch's post-handler looks up the resource's `scopeField` via getResource.
// The real resources aren't registered in this unit test, so mock it. The
// `--help` interception path (dispatch.ts's commandHelp) needs the real
// registry for resources registered via the real `registerResource` (e.g. the
// 'probes' probe below), so getResource falls back to the actual
// implementation for anything not explicitly stubbed via mockGetResource.
const mockGetResource = vi.fn();
vi.mock('./crud.js', async () => {
  const actual = await vi.importActual<typeof import('./crud.js')>('./crud.js');
  return {
    ...actual,
    getResource: (...args: Parameters<typeof actual.getResource>) => mockGetResource(...args),
  };
});

vi.mock('../modules/approvals/index.js', () => ({
  registerApprovalHandler: vi.fn(),
  requestApproval: vi.fn(),
}));

// Register a test command so dispatch has something to find
import { register } from './registry.js';

register({
  name: 'test-cmd',
  description: 'test command (non-group resource)',
  resource: 'test',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'groups-test',
  description: 'test command (groups resource)',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'general-cmd',
  description: 'test command (no resource, like help)',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'sessions-list',
  description: 'test command (sessions resource)',
  resource: 'sessions',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'destinations-list',
  description: 'test command (destinations resource)',
  resource: 'destinations',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'members-add',
  description: 'test command (members resource)',
  resource: 'members',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'wirings-list',
  description: 'test command (wirings resource — not allowed)',
  resource: 'wirings',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

// Commands that return data shaped like real resources (for post-handler filtering tests)
register({
  name: 'groups-list-data',
  description: 'returns mock group rows',
  resource: 'groups',
  access: 'open',
  generic: 'list',
  parseArgs: (raw) => raw,
  handler: async () => [
    { id: 'g1', name: 'my-group' },
    { id: 'g2', name: 'other-group' },
  ],
});

register({
  name: 'sessions-get-data',
  description: 'returns a mock session row',
  resource: 'sessions',
  access: 'open',
  generic: 'get',
  parseArgs: (raw) => raw,
  handler: async (args) => ({
    id: args.id,
    agent_group_id: (args as Record<string, unknown>).belongs_to ?? 'g1',
  }),
});

// A custom op under the `groups` resource that returns a config-shaped object
// (no `id` key). The post-handler must not touch this — only `generic` handlers.
register({
  name: 'groups-config-get',
  description: 'custom op returning a config object (no id)',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async () => ({ agent_group_id: 'g1', model: 'opus' }),
});

// The real `sessions-get` name — triggers the pre-handler ownership check.
register({
  name: 'sessions-get',
  description: 'generic sessions get',
  resource: 'sessions',
  access: 'open',
  generic: 'get',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ id: (args as Record<string, unknown>).id, agent_group_id: 'g1' }),
});

register({
  name: 'groups-get',
  description: 'test positional id parsing',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

import { dispatch } from './dispatch.js';
import { registerResource } from './crud.js';
import type { CallerContext } from './frame.js';

beforeEach(async () => {
  vi.clearAllMocks();
  // Default: the four CLI-whitelisted resources with their real scopeFields.
  // Anything else falls back to the actual registry lookup so resources
  // registered via the real `registerResource` (e.g. the 'probes' probe) are
  // still resolvable by the --help interception path.
  const actual = await vi.importActual<typeof import('./crud.js')>('./crud.js');
  const scopeFields: Record<string, string> = {
    groups: 'id',
    sessions: 'agent_group_id',
    destinations: 'agent_group_id',
    members: 'agent_group_id',
  };
  mockGetResource.mockImplementation((plural: string) =>
    scopeFields[plural] ? { scopeField: scopeFields[plural] } : actual.getResource(plural),
  );
});

describe('dash-joined positional id resolution', () => {
  it('preserves a generated id containing dashes', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const resp = await dispatch({ id: '1', command: `groups-get-${uuid}`, args: {} }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect((resp.data as { echo: Record<string, unknown> }).echo.id).toBe(uuid);
    }
  });
});

// --- Helpers ---

function agentCtx(overrides?: Partial<Extract<CallerContext, { caller: 'agent' }>>): CallerContext {
  return {
    caller: 'agent',
    sessionId: 's1',
    agentGroupId: 'g1',
    messagingGroupId: 'mg1',
    ...overrides,
  };
}

// --- Tests ---

describe('CLI scope enforcement', () => {
  it('disabled: rejects all CLI requests from agent', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'disabled' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('disabled');
    }
  });

  it('group: auto-fills --id with caller agent group', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { foo: 'bar' } }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.id).toBe('g1');
    }
  });

  it('group: rejects cross-group access', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { id: 'other-group' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('scoped');
    }
  });

  it('group: allows same-group id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { id: 'g1' } }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('group: blocks cli_scope escalation', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { cli_scope: 'global' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('cli_scope');
    }
  });

  it('group: blocks cli-scope escalation (hyphenated)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { 'cli-scope': 'global' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('group: blocks non-group resources', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('test');
    }
  });

  it('group: allows general commands with no resource (e.g. help)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'general-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('group: allows sessions, auto-fills --agent_group_id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'sessions-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.agent_group_id).toBe('g1');
      // --id should NOT be auto-filled for sessions (it's session UUID, not group)
      expect(data.echo.id).toBeUndefined();
    }
  });

  it('group: allows destinations, auto-fills --id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'destinations-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.id).toBe('g1');
    }
  });

  it('group: allows members, auto-fills --group', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'members-add', args: { user: 'u1' } }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.group).toBe('g1');
    }
  });

  it('group: blocks non-whitelisted resources (wirings)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'wirings-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('wirings');
    }
  });

  it('group: rejects cross-group --agent_group_id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch(
      { id: '1', command: 'sessions-list', args: { agent_group_id: 'other-group' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('group: rejects cross-group --group', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch(
      { id: '1', command: 'members-add', args: { user: 'u1', group: 'other-group' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('global: allows cross-group access', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: { id: 'other-group' } }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('global: allows non-group resources', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('global: does not auto-fill --id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: { foo: 'bar' } }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.id).toBeUndefined();
    }
  });

  it('defaults to group when cli_scope is missing', async () => {
    mockGetContainerConfig.mockReturnValue({});

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('host caller bypasses CLI scope enforcement', async () => {
    // No config check should happen for host callers
    const resp = await dispatch({ id: '1', command: 'test-cmd', args: { id: 'any-group' } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    expect(mockGetContainerConfig).not.toHaveBeenCalled();
  });

  // --- Post-handler filtering ---

  it('group: groups list filters out other groups', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-list-data', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as Array<{ id: string }>;
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('g1');
    }
  });

  it('group: sessions get rejects cross-group session', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch(
      { id: '1', command: 'sessions-get-data', args: { id: 's-123', belongs_to: 'other-group' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('different agent group');
    }
  });

  it('group: sessions get allows own-group session', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch(
      { id: '1', command: 'sessions-get-data', args: { id: 's-123', belongs_to: 'g1' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(true);
  });

  it('global: no post-handler filtering', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    const resp = await dispatch({ id: '1', command: 'groups-list-data', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as Array<{ id: string }>;
      expect(data).toHaveLength(2); // both groups returned
    }
  });

  // --- Custom ops bypass post-handler row filtering (regression: #2392 review) ---

  it('group: a custom op returning a non-row object is not falsely rejected', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    // groups-config-get is access:open and reachable by a group-scoped agent;
    // it returns { agent_group_id, model } with no `id` field. Before this fix
    // the post-handler compared data['id'] (undefined) and returned forbidden.
    const resp = await dispatch({ id: '1', command: 'groups-config-get', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect((resp.data as { model: string }).model).toBe('opus');
    }
  });

  // --- sessions-get pre-handler ownership check (no existence oracle) ---

  it('group: sessions-get returns "session not found" for a foreign session UUID', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockGetSession.mockReturnValue({ id: 's-x', agent_group_id: 'other-group' });

    const resp = await dispatch({ id: '1', command: 'sessions-get', args: { id: 's-x' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('handler-error');
      expect(resp.error.message).toContain('session not found');
    }
  });

  it('group: sessions-get returns "session not found" for a non-existent UUID', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockGetSession.mockReturnValue(undefined);

    const resp = await dispatch({ id: '1', command: 'sessions-get', args: { id: 's-nope' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('handler-error');
      expect(resp.error.message).toContain('session not found');
    }
  });

  it('group: sessions-get allows the caller’s own session', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockGetSession.mockReturnValue({ id: 's-mine', agent_group_id: 'g1' });

    const resp = await dispatch({ id: '1', command: 'sessions-get', args: { id: 's-mine' } }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  // --- Fail-closed regression guard for a missing scopeField ---

  it('group: generic list/get fails closed when the resource declares no scopeField', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockGetResource.mockReturnValue(undefined); // a whitelisted resource that forgot scopeField

    const resp = await dispatch({ id: '1', command: 'groups-list-data', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('not available in group scope');
    }
  });

  it('carries formatHuman output in the response frame human field', async () => {
    register({
      name: 'human-probe',
      description: 'probe',
      access: 'open',
      parseArgs: () => ({}),
      handler: async () => [{ a: 1 }],
      formatHuman: (data) => `rendered:${JSON.stringify(data)}`,
    });
    const res = await dispatch({ id: 'r1', command: 'human-probe', args: {} }, { caller: 'host' });
    expect(res.ok).toBe(true);
    expect(res.ok && res.human).toBe('rendered:[{"a":1}]');
  });

  it('omits human when the command declares no formatHuman', async () => {
    register({
      name: 'plain-probe',
      description: 'probe',
      access: 'open',
      parseArgs: () => ({}),
      handler: async () => ({ b: 2 }),
    });
    const res = await dispatch({ id: 'r2', command: 'plain-probe', args: {} }, { caller: 'host' });
    expect(res.ok && res.human).toBeUndefined();
  });

  it('intercepts --help and returns generated verb help without running the handler', async () => {
    let ran = false;
    registerResource({
      name: 'probe',
      plural: 'probes',
      table: 'probes',
      description: 'probe resource',
      idColumn: 'id',
      columns: [{ name: 'id', type: 'string', description: 'id' }],
      operations: {},
      customOperations: {
        poke: {
          access: 'approval',
          description: 'Poke it.',
          args: [{ name: 'force', type: 'boolean', description: 'Force the poke.' }],
          handler: async () => {
            ran = true;
            return {};
          },
        },
      },
    });
    const res = await dispatch({ id: 'h1', command: 'probes-poke', args: { help: true } }, { caller: 'host' });
    expect(ran).toBe(false);
    expect(res.ok).toBe(true);
    expect(res.ok && res.human).toContain('--force');
  });
});
