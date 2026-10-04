import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  hasGrant: vi.fn(),
  listGranted: vi.fn(),
  listProfiles: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('../db/integration-profiles.js', () => ({
  getIntegrationProfileRow: mocks.getProfile,
  hasIntegrationProfileGrant: mocks.hasGrant,
  listGrantedIntegrationProfileRows: mocks.listGranted,
  listIntegrationProfileRows: mocks.listProfiles,
}));

vi.mock('./invoker.js', () => {
  class InvocationError extends Error {
    constructor(
      readonly resultClass: string,
      readonly stage: string,
    ) {
      super('safe integration failure');
    }
  }
  return {
    hostIntegrationInvoker: { invoke: mocks.invoke },
    HostIntegrationInvocationError: InvocationError,
  };
});

import { invokeGrantedHostIntegration } from './invocation-surface.js';

const caller = {
  caller: 'agent' as const,
  agentGroupId: 'synthetic-agent',
  sessionId: 'synthetic-session',
  messagingGroupId: 'synthetic-channel',
};
const request = {
  caller,
  adapterId: 'synthetic-records',
  adapterVersion: 2,
  operation: 'records.read',
  input: { limit: 5 },
};

describe('grant-gated host integration invocation surface', () => {
  beforeEach(() => vi.clearAllMocks());

  it('selects the one exact granted adapter version and delegates to the invoker', async () => {
    mocks.listGranted.mockReturnValue([{ id: 'synthetic-profile' }]);
    mocks.invoke.mockResolvedValue({ data: { records: [] } });

    await invokeGrantedHostIntegration(request);

    expect(mocks.listGranted).toHaveBeenCalledWith('synthetic-agent', 'synthetic-records', 2, 'records.read');
    expect(mocks.invoke).toHaveBeenCalledWith({
      caller,
      profile: 'synthetic-profile',
      operation: 'records.read',
      input: { limit: 5 },
      signal: undefined,
    });
  });

  it('requires an explicit authorized profile when multiple exact grants match', async () => {
    mocks.listGranted.mockReturnValue([{ id: 'one' }, { id: 'two' }]);
    await expect(invokeGrantedHostIntegration(request)).rejects.toMatchObject({
      resultClass: 'invalid_configuration',
      stage: 'authorization',
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('makes missing and ungranted explicit profiles indistinguishable', async () => {
    mocks.getProfile.mockReturnValueOnce(undefined).mockReturnValueOnce({
      id: 'synthetic-profile',
      adapter_id: 'synthetic-records',
      adapter_version: 2,
    });
    mocks.hasGrant.mockReturnValue(false);

    for (const profile of ['missing-profile', 'synthetic-profile']) {
      await expect(invokeGrantedHostIntegration({ ...request, profile })).rejects.toMatchObject({
        resultClass: 'not_authorized',
        stage: 'authorization',
      });
    }
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
