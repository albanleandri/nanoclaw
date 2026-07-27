import { describe, expect, it, vi } from 'vitest';

const transferOwner = vi.fn().mockReturnValue({ owner_agent_group_id: 'pinova-codex' });

vi.mock('../../shared-resource-reconciliation.js', () => ({
  approveSharedResourceReconciliation: vi.fn(),
  prepareSharedResourceReconciliation: vi.fn(),
  sharedResourceReconciliationStatus: vi.fn(),
  transferSharedResourceReconciliationOwner: (...args: unknown[]) => transferOwner(...args),
  validateSharedResourceReconciliation: vi.fn(),
}));

import { lookup } from '../registry.js';
import './shared-resources.js';

describe('shared-resources owner-transfer CLI registration', () => {
  it('is approval-gated and maps normalized arguments to the policy handler', async () => {
    const command = lookup('shared-resources-owner-transfer');
    expect(command?.access).toBe('approval');

    const args = command!.parseArgs({
      name: 'trading-data',
      'new-owner-agent-group-id': 'pinova-codex',
      'expected-owner-agent-group-id': 'pinova-claude',
      'expected-version': 4,
      confirm: 'trading-data',
    });
    await command!.handler(args, { caller: 'host' });

    expect(transferOwner).toHaveBeenCalledWith('trading-data', 'pinova-codex', 'pinova-claude', 4, 'trading-data');
  });
});
