/**
 * Regression coverage for create_agent host-side authorization.
 *
 * create_agent writes central DB and host filesystem state. The container MCP
 * gate is not trusted, so the host must authorize the system action too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';

const mockRequestApproval = vi.fn().mockResolvedValue(undefined);
const mockGetContainerConfig = vi.fn();
const mockCreateAgentGroup = vi.fn();
const mockInitGroupFilesystem = vi.fn();
const mockWriteDestinations = vi.fn();
const mockNotifyWrite = vi.fn();

vi.mock('../approvals/index.js', () => ({
  requestApproval: (...args: unknown[]) => mockRequestApproval(...args),
}));

vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: (...args: unknown[]) => mockGetContainerConfig(...args),
}));

vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => ({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: '' }),
  getAgentGroupByFolder: () => undefined,
  createAgentGroup: (...args: unknown[]) => mockCreateAgentGroup(...args),
}));

vi.mock('../../group-init.js', () => ({
  initGroupFilesystem: (...args: unknown[]) => mockInitGroupFilesystem(...args),
}));

vi.mock('./write-destinations.js', () => ({
  writeDestinations: (...args: unknown[]) => mockWriteDestinations(...args),
}));

vi.mock('./db/agent-destinations.js', () => ({
  getDestinationByName: () => undefined,
  createDestination: vi.fn(),
  normalizeName: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
}));

vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...args: unknown[]) => mockNotifyWrite(...args),
}));

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db/sessions.js', () => ({
  getSession: (id: string) => ({ id, agent_group_id: 'ag-1' }),
}));

import { handleCreateAgent } from './create-agent.js';

const SESSION = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleCreateAgent authorization', () => {
  it('creates directly for global CLI-scope groups', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await handleCreateAgent({ name: 'Scout', instructions: 'help' }, SESSION);

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    expect(mockInitGroupFilesystem).toHaveBeenCalledTimes(1);
  });

  it('requires approval for group CLI-scope groups', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await handleCreateAgent({ name: 'Scout', instructions: 'help' }, SESSION);

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockRequestApproval.mock.calls[0][0]).toMatchObject({ action: 'create_agent' });
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockInitGroupFilesystem).not.toHaveBeenCalled();
  });

  it('fails closed to approval when config is missing', async () => {
    mockGetContainerConfig.mockReturnValue(undefined);

    await handleCreateAgent({ name: 'Scout' }, SESSION);

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('requires approval for disabled or unknown CLI scope', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'disabled' });

    await handleCreateAgent({ name: 'Scout' }, SESSION);

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('does not create or request approval for an empty name', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await handleCreateAgent({ name: '' }, SESSION);

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });
});
