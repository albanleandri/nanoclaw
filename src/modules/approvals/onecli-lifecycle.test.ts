import type { ApprovalRequest } from '@onecli-sh/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { getPendingApproval, getPendingApprovalsByAction } from '../../db/sessions.js';

vi.mock('./primitive.js', () => ({
  pickApprover: () => ['telegram:owner'],
  pickApprovalDelivery: vi.fn().mockResolvedValue({
    userId: 'telegram:owner',
    messagingGroup: {
      id: 'mg-admin',
      channel_type: 'telegram',
      platform_id: 'admin-dm',
    },
  }),
}));

vi.mock('../../config.js', () => ({
  ONECLI_API_KEY: 'test-key',
  ONECLI_URL: 'http://127.0.0.1:1',
}));

import { handleOneCLIApprovalRequest, ONECLI_ACTION } from './onecli-approvals.js';

describe('OneCLI approval lifecycle', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    closeDb();
  });

  it('persists resolver state before delivery and cleans it up when delivery fails', async () => {
    let approvalId = '';
    const adapter = {
      async deliver(
        _channelType: string,
        _platformId: string,
        _threadId: string | null,
        _kind: string,
        content: string,
      ) {
        approvalId = JSON.parse(content).questionId as string;
        expect(getPendingApproval(approvalId)?.status).toBe('pending');
        throw new Error('platform unavailable');
      },
    };

    const request: ApprovalRequest = {
      id: 'onecli-request-1',
      method: 'GET',
      url: 'https://example.com/private',
      host: 'example.com',
      path: '/private',
      headers: {},
      bodyPreview: null,
      agent: { id: 'agent-1', name: 'Agent', externalId: 'ag-1' },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      timeoutSeconds: 60,
    };

    await expect(handleOneCLIApprovalRequest(request, adapter)).resolves.toBe('deny');
    expect(approvalId).not.toBe('');
    expect(getPendingApprovalsByAction(ONECLI_ACTION)).toEqual([]);
  });
});
