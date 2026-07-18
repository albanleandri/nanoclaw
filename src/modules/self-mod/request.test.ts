/**
 * Tests for the input-validation layer in self-mod request handlers.
 *
 * The handlers themselves delegate to requestApproval after validating.
 * We mock the heavy collaborators (approvals, container-runner, DB) so
 * these tests exercise only the validation logic — which is a security
 * boundary: invalid package names reaching shell exec would be a vuln.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock heavy collaborators before importing the module under test.
vi.mock('../approvals/index.js', () => ({
  notifyAgent: vi.fn(),
  requestApproval: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(),
}));
vi.mock('../../log.js', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { notifyAgent, requestApproval } from '../approvals/index.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import { escapeInvisibles, handleInstallPackages, handleAddMcpServer } from './request.js';

const mockNotify = vi.mocked(notifyAgent);
const mockRequest = vi.mocked(requestApproval);
const mockGetAgentGroup = vi.mocked(getAgentGroup);
const mockLog = vi.mocked(log);

const FAKE_SESSION = {
  id: 'sess-1',
  agent_group_id: 'ag-1',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active' as const,
  container_status: 'stopped' as const,
  last_active: null,
  created_at: new Date().toISOString(),
};

const FAKE_AGENT_GROUP = { id: 'ag-1', name: 'TestAgent', folder: 'test', agent_provider: null, created_at: '' };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgentGroup.mockReturnValue(FAKE_AGENT_GROUP as ReturnType<typeof getAgentGroup>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── handleInstallPackages ──

describe('handleInstallPackages — missing agent group', () => {
  it('notifies the agent and returns without requesting approval', async () => {
    mockGetAgentGroup.mockReturnValue(undefined);
    await handleInstallPackages({ apt: ['curl'] }, FAKE_SESSION);
    expect(mockNotify).toHaveBeenCalledWith(FAKE_SESSION, expect.stringContaining('agent group not found'));
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('handleInstallPackages — empty package list', () => {
  it('requires at least one apt or npm package', async () => {
    await handleInstallPackages({ apt: [], npm: [] }, FAKE_SESSION);
    expect(mockNotify).toHaveBeenCalledWith(FAKE_SESSION, expect.stringContaining('at least one'));
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('treats missing apt/npm as empty', async () => {
    await handleInstallPackages({}, FAKE_SESSION);
    expect(mockNotify).toHaveBeenCalledWith(FAKE_SESSION, expect.stringContaining('at least one'));
  });
});

describe('handleInstallPackages — package count limit', () => {
  it('rejects more than 20 packages', async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `pkg${i}`);
    await handleInstallPackages({ npm: tooMany }, FAKE_SESSION);
    expect(mockNotify).toHaveBeenCalledWith(FAKE_SESSION, expect.stringContaining('max 20'));
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('allows exactly 20 packages', async () => {
    const exactly20 = Array.from({ length: 20 }, (_, i) => `pkg${i}`);
    await handleInstallPackages({ npm: exactly20 }, FAKE_SESSION);
    expect(mockRequest).toHaveBeenCalledOnce();
  });
});

describe('handleInstallPackages — apt name validation', () => {
  it.each(['curl', 'libssl-dev', 'python3.12', 'my_package', 'pkg+extra'])(
    'accepts valid apt name: %s',
    async (name) => {
      await handleInstallPackages({ apt: [name] }, FAKE_SESSION);
      expect(mockRequest).toHaveBeenCalledOnce();
      expect(mockNotify).not.toHaveBeenCalled();
    },
  );

  it.each(['; rm -rf /', '$(whoami)', '../traversal', 'UPPERCASE', '-starts-with-dash', 'has spaces', ''])(
    'rejects invalid apt name: %s',
    async (name) => {
      await handleInstallPackages({ apt: [name] }, FAKE_SESSION);
      expect(mockNotify).toHaveBeenCalledWith(FAKE_SESSION, expect.stringContaining('invalid apt package'));
      expect(mockLog.warn).toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
    },
  );
});

describe('handleInstallPackages — npm name validation', () => {
  it.each(['express', 'lodash', '@types/node', '@anthropic-ai/sdk', 'my-package'])(
    'accepts valid npm name: %s',
    async (name) => {
      await handleInstallPackages({ npm: [name] }, FAKE_SESSION);
      expect(mockRequest).toHaveBeenCalledOnce();
      expect(mockNotify).not.toHaveBeenCalled();
    },
  );

  it.each(['; rm -rf /', '$(evil)', '../path-traversal', '@UPPERCASE/pkg', 'UPPERCASE', '-bad-start', 'has spaces'])(
    'rejects invalid npm name: %s',
    async (name) => {
      await handleInstallPackages({ npm: [name] }, FAKE_SESSION);
      expect(mockNotify).toHaveBeenCalledWith(FAKE_SESSION, expect.stringContaining('invalid npm package'));
      expect(mockLog.warn).toHaveBeenCalled();
      expect(mockRequest).not.toHaveBeenCalled();
    },
  );
});

describe('handleInstallPackages — valid request', () => {
  it('calls requestApproval with the right payload', async () => {
    await handleInstallPackages({ apt: ['curl'], npm: ['express'], reason: 'need http' }, FAKE_SESSION);
    expect(mockRequest).toHaveBeenCalledOnce();
    const opts = mockRequest.mock.calls[0][0];
    expect(opts.action).toBe('install_packages');
    expect(opts.payload).toEqual({ apt: ['curl'], npm: ['express'], reason: 'need http' });
    expect(opts.agentName).toBe('TestAgent');
  });
});

// ── handleAddMcpServer ──

describe('handleAddMcpServer — missing agent group', () => {
  it('notifies and returns without requesting approval', async () => {
    mockGetAgentGroup.mockReturnValue(undefined);
    await handleAddMcpServer({ name: 'my-server', command: 'npx' }, FAKE_SESSION);
    expect(mockNotify).toHaveBeenCalledWith(FAKE_SESSION, expect.stringContaining('agent group not found'));
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('handleAddMcpServer — missing required fields', () => {
  it('requires name', async () => {
    await handleAddMcpServer({ command: 'npx' }, FAKE_SESSION);
    expect(mockNotify).toHaveBeenCalledWith(FAKE_SESSION, expect.stringContaining('name and command are required'));
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('requires command', async () => {
    await handleAddMcpServer({ name: 'my-server' }, FAKE_SESSION);
    expect(mockNotify).toHaveBeenCalledWith(FAKE_SESSION, expect.stringContaining('name and command are required'));
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('handleAddMcpServer — valid request', () => {
  it('calls requestApproval with the right payload', async () => {
    await handleAddMcpServer(
      { name: 'my-tool', command: 'npx', args: ['-y', '@foo/bar'], env: { KEY: 'val' } },
      FAKE_SESSION,
    );
    expect(mockRequest).toHaveBeenCalledOnce();
    const opts = mockRequest.mock.calls[0][0];
    expect(opts.action).toBe('add_mcp_server');
    expect(opts.payload).toEqual({
      name: 'my-tool',
      command: 'npx',
      args: ['-y', '@foo/bar'],
      env: { KEY: 'val' },
    });
  });

  it('defaults args to [] and env to {} when omitted', async () => {
    await handleAddMcpServer({ name: 'bare', command: 'cmd' }, FAKE_SESSION);
    const opts = mockRequest.mock.calls[0][0];
    expect(opts.payload.args).toEqual([]);
    expect(opts.payload.env).toEqual({});
  });

  it('shows every applied field inside one intact code fence', async () => {
    await handleAddMcpServer(
      {
        name: 'server',
        command: 'node',
        args: ['--flag', '```\nfake fence'],
        env: { MODE: 'safe', NOTE: 'line1\nline2' },
      },
      FAKE_SESSION,
    );

    const opts = mockRequest.mock.calls[0][0];
    expect(opts.question.split('```')).toHaveLength(3);
    expect(opts.question).toContain('name: "server"');
    expect(opts.question).toContain('command: "node"');
    expect(opts.question).toContain('--flag');
    expect(opts.question).toContain('MODE');
    expect(opts.question).toContain('line1\\nline2');
    expect(opts.question).toContain('\\u0060\\u0060\\u0060');
  });

  it('redacts secret-shaped card values while preserving the approval payload', async () => {
    await handleAddMcpServer(
      {
        name: 'server',
        command: 'node',
        args: ['--token', 'ghp_deadbeef'],
        env: { API_KEY: 'plain-looking-secret', MODE: 'safe' },
      },
      FAKE_SESSION,
    );

    const opts = mockRequest.mock.calls[0][0];
    expect(opts.question).not.toContain('ghp_deadbeef');
    expect(opts.question).not.toContain('plain-looking-secret');
    expect(opts.question).toContain('<redacted:');
    expect(opts.question).toContain('MODE');
    expect(opts.question).toContain('safe');
    expect(opts.payload).toEqual({
      name: 'server',
      command: 'node',
      args: ['--token', 'ghp_deadbeef'],
      env: { API_KEY: 'plain-looking-secret', MODE: 'safe' },
    });
  });
});

describe('handleAddMcpServer — validation and bounds', () => {
  it('rejects malformed args and env before requesting approval', async () => {
    await handleAddMcpServer({ name: 'server', command: 'node', args: ['ok', 1] }, FAKE_SESSION);
    expect(mockNotify).toHaveBeenCalledWith(FAKE_SESSION, expect.stringContaining('array of strings'));
    expect(mockRequest).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockGetAgentGroup.mockReturnValue(FAKE_AGENT_GROUP as ReturnType<typeof getAgentGroup>);
    await handleAddMcpServer({ name: 'server', command: 'node', env: ['bad'] }, FAKE_SESSION);
    expect(mockNotify).toHaveBeenCalledWith(FAKE_SESSION, expect.stringContaining('map of string'));
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('rejects excessive argument and environment counts', async () => {
    await handleAddMcpServer(
      { name: 'server', command: 'node', args: Array.from({ length: 33 }, (_, i) => `a${i}`) },
      FAKE_SESSION,
    );
    expect(mockNotify).toHaveBeenCalledWith(FAKE_SESSION, expect.stringContaining('max 32 args'));
    expect(mockRequest).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockGetAgentGroup.mockReturnValue(FAKE_AGENT_GROUP as ReturnType<typeof getAgentGroup>);
    const env = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`K${i}`, 'v']));
    await handleAddMcpServer({ name: 'server', command: 'node', env }, FAKE_SESSION);
    expect(mockNotify).toHaveBeenCalledWith(FAKE_SESSION, expect.stringContaining('max 32 env'));
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('rejects oversized raw payloads and rendered cards', async () => {
    await handleAddMcpServer({ name: 'server', command: 'node', args: [`sk-${'a'.repeat(17_000)}`] }, FAKE_SESSION);
    expect(mockNotify).toHaveBeenCalledWith(FAKE_SESSION, expect.stringContaining('16384 bytes'));
    expect(mockRequest).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockGetAgentGroup.mockReturnValue(FAKE_AGENT_GROUP as ReturnType<typeof getAgentGroup>);
    await handleAddMcpServer({ name: 'server', command: 'node', args: ['a'.repeat(1600)] }, FAKE_SESSION);
    expect(mockNotify).toHaveBeenCalledWith(FAKE_SESSION, expect.stringContaining('1500 bytes'));
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('escapeInvisibles', () => {
  it('makes bidi, zero-width, separators, and backticks visible', () => {
    expect(escapeInvisibles('a\u202eb\u200bc\ufeff`')).toBe('a\\u202eb\\u200bc\\ufeff\\u0060');
  });
});
