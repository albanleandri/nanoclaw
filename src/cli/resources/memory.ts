import { randomUUID } from 'node:crypto';

import {
  acquireAgentGroupMemoryFence,
  getAgentGroupMemoryControl,
  releaseAgentGroupMemoryFence,
} from '../../db/agent-group-memory-control.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { isContainerRunning, isContainerWakeInFlight } from '../../container-runner.js';
import { runMemoryValidatorContainer } from '../../memory-operator.js';
import {
  approveMemoryMigration,
  finishMemoryMigration,
  prepareMemoryMigration,
  readMemoryMigrationLedger,
  recordMemoryMigrationClassification,
  recordMemoryMigrationSmokeTests,
  rollbackMemoryMigration,
  validateMemoryMigration,
} from '../../memory-migration.js';
import { registerResource } from '../crud.js';

function requireGroupId(args: Record<string, unknown>): string {
  const id = args.agent_group_id as string;
  if (!id) throw new Error('--agent-group-id is required');
  return id;
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name.replaceAll('_', '-')} is required`);
  return value.trim();
}

function legacyPaths(args: Record<string, unknown>): string[] {
  if (args.legacy_paths === undefined) return ['CLAUDE.local.md'];
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(args.legacy_paths));
  } catch (error) {
    throw new Error('--legacy-paths must be a JSON array of workspace-relative paths', { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('--legacy-paths must be a JSON array of workspace-relative paths');
  }
  return parsed;
}

function memoryStatus(agentGroupId: string): Record<string, unknown> {
  const control = getAgentGroupMemoryControl(agentGroupId);
  if (!control) throw new Error(`Memory control not found for group: ${agentGroupId}`);
  return {
    ...control,
    sessions: getSessionsByAgentGroup(agentGroupId).map((session) => ({
      id: session.id,
      status: session.status,
      container_status: session.container_status,
      memory_access:
        control.mode === 'disabled' ? 'none' : control.writer_session_id === session.id ? 'read-write' : 'read-only',
      active_container: isContainerRunning(session.id),
      wake_in_flight: isContainerWakeInFlight(session.id),
    })),
  };
}

registerResource({
  name: 'memory',
  plural: 'memory',
  table: 'agent_group_memory_control',
  description: 'Operator-only neutral-memory validation, rollout status, maintenance fencing, and writer inspection.',
  idColumn: 'agent_group_id',
  columns: [],
  operations: {},
  customOperations: {
    'migrate-prepare': {
      access: 'approval',
      description:
        'Start or resume a fenced migration through content-blind staging. Use --agent-group-id <id> [--legacy-paths \'["CLAUDE.local.md"]\'].',
      args: [
        { name: 'agent_group_id', type: 'string', description: 'Exact agent group to migrate.', required: true },
        {
          name: 'legacy_paths',
          type: 'string',
          description: 'JSON array of explicit workspace-relative legacy authority paths.',
        },
      ],
      handler: async (args) => prepareMemoryMigration(requireGroupId(args), legacyPaths(args)),
    },
    'migrate-status': {
      access: 'open',
      description: 'Read the durable metadata-only migration ledger. Use --agent-group-id <id>.',
      args: [{ name: 'agent_group_id', type: 'string', description: 'Agent group to inspect.', required: true }],
      handler: async (args) => {
        const ledger = readMemoryMigrationLedger(requireGroupId(args));
        if (!ledger) throw new Error('No memory migration workflow exists for this group');
        return ledger;
      },
    },
    'migrate-classify': {
      access: 'approval',
      description:
        'Record a coding-harness source-to-destination report after classification. Use --report-path <workspace-relative JSON path>.',
      args: [
        { name: 'agent_group_id', type: 'string', description: 'Agent group being migrated.', required: true },
        {
          name: 'report_path',
          type: 'string',
          description: 'Workspace-relative classification report.',
          required: true,
        },
      ],
      handler: async (args) =>
        recordMemoryMigrationClassification(requireGroupId(args), requireString(args, 'report_path')),
    },
    'migrate-validate': {
      access: 'approval',
      description: 'Validate classified memory in the isolated operator container and record shadow/validated.',
      args: [{ name: 'agent_group_id', type: 'string', description: 'Agent group being migrated.', required: true }],
      handler: async (args) => validateMemoryMigration(requireGroupId(args)),
    },
    'migrate-approve': {
      access: 'approval',
      description: 'Explicit cutover to active/migrated. Requires --workflow-id <id> and --writer-session-id <id>.',
      args: [
        { name: 'agent_group_id', type: 'string', description: 'Agent group being migrated.', required: true },
        { name: 'workflow_id', type: 'string', description: 'Exact workflow ID from the ledger.', required: true },
        { name: 'writer_session_id', type: 'string', description: 'Selected group writer session.', required: true },
      ],
      handler: async (args) =>
        approveMemoryMigration(
          requireGroupId(args),
          requireString(args, 'workflow_id'),
          requireString(args, 'writer_session_id'),
        ),
    },
    'migrate-finish': {
      access: 'approval',
      description: 'Resume only workflow-paused schedules and release the exact migration fence.',
      args: [{ name: 'agent_group_id', type: 'string', description: 'Agent group being migrated.', required: true }],
      handler: async (args) => finishMemoryMigration(requireGroupId(args)),
    },
    'migrate-smoke': {
      access: 'approval',
      description:
        'Record passing recall/correction/clear/compact/provider-switch smoke checks and complete the workflow.',
      args: [
        { name: 'agent_group_id', type: 'string', description: 'Agent group being migrated.', required: true },
        { name: 'report_path', type: 'string', description: 'Workspace-relative smoke report JSON.', required: true },
      ],
      handler: async (args) =>
        recordMemoryMigrationSmokeTests(requireGroupId(args), requireString(args, 'report_path')),
    },
    'migrate-rollback': {
      access: 'approval',
      description:
        'Rollback using the durable ledger. Requires exact --workflow-id; never overwrites pre-approval paths.',
      args: [
        { name: 'agent_group_id', type: 'string', description: 'Agent group being rolled back.', required: true },
        { name: 'workflow_id', type: 'string', description: 'Exact workflow ID from the ledger.', required: true },
      ],
      handler: async (args) => rollbackMemoryMigration(requireGroupId(args), requireString(args, 'workflow_id')),
    },
    validate: {
      access: 'open',
      description:
        'Validate one group memory tree in an isolated read-only container. Use --agent-group-id <id>. Bodies never enter host output.',
      args: [
        {
          name: 'agent_group_id',
          type: 'string',
          description: 'Agent group whose private memory tree will be mounted read-only.',
          required: true,
        },
      ],
      handler: async (args) => runMemoryValidatorContainer(requireGroupId(args)),
    },
    status: {
      access: 'open',
      description: 'Show rollout, fence, writer, and per-session effective access. Use --agent-group-id <id>.',
      args: [
        {
          name: 'agent_group_id',
          type: 'string',
          description: 'Agent group to inspect.',
          required: true,
        },
      ],
      handler: async (args) => memoryStatus(requireGroupId(args)),
    },
    writer: {
      access: 'open',
      description: 'Inspect the designated writer and session access. Use --agent-group-id <id>.',
      args: [
        {
          name: 'agent_group_id',
          type: 'string',
          description: 'Agent group to inspect.',
          required: true,
        },
      ],
      handler: async (args) => {
        const status = memoryStatus(requireGroupId(args));
        return {
          agent_group_id: status.agent_group_id,
          mode: status.mode,
          writer_session_id: status.writer_session_id,
          version: status.version,
          sessions: status.sessions,
        };
      },
    },
    fence: {
      access: 'approval',
      description:
        'Acquire a durable wake/spawn fence. Use --agent-group-id <id> [--owner <label>]. Preserve the returned token for unfence.',
      args: [
        {
          name: 'agent_group_id',
          type: 'string',
          description: 'Agent group to fence.',
          required: true,
        },
        {
          name: 'owner',
          type: 'string',
          description: 'Bounded operator/workflow label.',
        },
      ],
      handler: async (args) => {
        const id = requireGroupId(args);
        const owner = String(args.owner ?? 'ncl-memory-operator').trim();
        if (!owner || owner.length > 128) throw new Error('--owner must contain 1 to 128 characters');
        const token = randomUUID();
        if (!acquireAgentGroupMemoryFence(id, owner, token)) {
          throw new Error(`Memory maintenance fence is already held for group: ${id}`);
        }
        return { agent_group_id: id, owner, token, fenced: true };
      },
    },
    unfence: {
      access: 'approval',
      description:
        'Release a durable wake/spawn fence using its exact token. Use --agent-group-id <id> --token <token>.',
      args: [
        {
          name: 'agent_group_id',
          type: 'string',
          description: 'Agent group to unfence.',
          required: true,
        },
        {
          name: 'token',
          type: 'string',
          description: 'Exact token returned by memory fence.',
          required: true,
        },
      ],
      handler: async (args) => {
        const id = requireGroupId(args);
        const token = args.token as string;
        if (!token) throw new Error('--token is required');
        if (!releaseAgentGroupMemoryFence(id, token)) {
          throw new Error(`Memory fence token did not match for group: ${id}`);
        }
        return { agent_group_id: id, unfenced: true };
      },
    },
  },
});
