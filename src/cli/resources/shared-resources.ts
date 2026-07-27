import {
  approveSharedResourceReconciliation,
  prepareSharedResourceReconciliation,
  sharedResourceReconciliationStatus,
  transferSharedResourceReconciliationOwner,
  validateSharedResourceReconciliation,
} from '../../shared-resource-reconciliation.js';
import { registerResource } from '../crud.js';

function required(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name.replaceAll('_', '-')} is required`);
  return value.trim();
}

registerResource({
  name: 'shared-resource',
  plural: 'shared-resources',
  table: 'shared_resource_control',
  description: 'Explicit shared-resource ownership, reconciliation, validation, and effective access.',
  idColumn: 'resource_name',
  columns: [],
  operations: {},
  customOperations: {
    status: {
      access: 'open',
      description: 'Show reconciliation state, grants, owner, and effective access without reading resource bodies.',
      args: [{ name: 'name', type: 'string', description: 'Shared resource name.', required: true }],
      handler: async (args) => sharedResourceReconciliationStatus(required(args, 'name')),
    },
    'reconcile-prepare': {
      access: 'approval',
      description:
        'Inventory one explicitly granted resource and select its owner. Use --name <resource> --owner-agent-group-id <id>.',
      args: [
        { name: 'name', type: 'string', description: 'Shared resource name.', required: true },
        { name: 'owner_agent_group_id', type: 'string', description: 'Selected writer-owner group.', required: true },
      ],
      handler: async (args) =>
        prepareSharedResourceReconciliation(required(args, 'name'), required(args, 'owner_agent_group_id')),
    },
    'reconcile-validate': {
      access: 'approval',
      description: 'Record a classification report and run isolated structural validation.',
      args: [
        { name: 'name', type: 'string', description: 'Shared resource name.', required: true },
        {
          name: 'report_path',
          type: 'string',
          description: 'Classification report under ignored data/.',
          required: true,
        },
      ],
      handler: async (args) =>
        validateSharedResourceReconciliation(required(args, 'name'), required(args, 'report_path')),
    },
    'reconcile-approve': {
      access: 'approval',
      description:
        'Approve owner write access after validation. Requires --confirm <resource> and exact --expected-version.',
      args: [
        { name: 'name', type: 'string', description: 'Shared resource name.', required: true },
        { name: 'expected_version', type: 'number', description: 'Exact validated control version.', required: true },
        { name: 'confirm', type: 'string', description: 'Exact resource name confirmation.', required: true },
      ],
      handler: async (args) =>
        approveSharedResourceReconciliation(
          required(args, 'name'),
          Number(args.expected_version),
          required(args, 'confirm'),
        ),
    },
    'owner-transfer': {
      access: 'approval',
      description:
        'Transfer reconciled write ownership to another granted group. Requires all granted-group containers stopped and compare-and-swap owner/version inputs.',
      args: [
        { name: 'name', type: 'string', description: 'Shared resource name.', required: true },
        {
          name: 'new_owner_agent_group_id',
          type: 'string',
          description: 'Granted group that will become the sole writer.',
          required: true,
        },
        {
          name: 'expected_owner_agent_group_id',
          type: 'string',
          description: 'Current owner expected by the operator.',
          required: true,
        },
        {
          name: 'expected_version',
          type: 'number',
          description: 'Current control version for optimistic concurrency.',
          required: true,
        },
        { name: 'confirm', type: 'string', description: 'Exact resource name confirmation.', required: true },
      ],
      handler: async (args) =>
        transferSharedResourceReconciliationOwner(
          required(args, 'name'),
          required(args, 'new_owner_agent_group_id'),
          required(args, 'expected_owner_agent_group_id'),
          Number(args.expected_version),
          required(args, 'confirm'),
        ),
    },
  },
});
