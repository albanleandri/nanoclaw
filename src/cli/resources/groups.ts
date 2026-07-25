import { randomUUID } from 'crypto';

import type { McpServerConfig } from '../../container-config.js';
import {
  buildAgentGroupImage,
  drainContainerWakes,
  isContainerRunning,
  isContainerWakeInFlight,
  killContainer,
  wakeContainer,
} from '../../container-runner.js';
import { validatePackageName } from '../../package-names.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { getDb, hasTable } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import {
  acquireAgentGroupMemoryFence,
  getAgentGroupMemoryControl,
  releaseAgentGroupMemoryFence,
  transferAgentGroupMemoryWriter,
} from '../../db/agent-group-memory-control.js';
import { writeSessionMessage } from '../../session-manager.js';
import {
  getContainerConfig,
  updateContainerConfigScalars,
  updateContainerConfigJson,
} from '../../db/container-configs.js';
import type { ContainerConfigRow } from '../../types.js';
import { getProviderProfile } from '../../db/provider-profiles.js';
import '../../providers/descriptors/index.js';
import { requireProviderDescriptor } from '../../providers/provider-descriptor-registry.js';
import { registerResource } from '../crud.js';

/** Deserialize JSON columns for display. */
function presentConfig(row: ContainerConfigRow): Record<string, unknown> {
  return {
    agent_group_id: row.agent_group_id,
    provider_profile_id: row.provider_profile_id ?? null,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    image_tag: row.image_tag,
    assistant_name: row.assistant_name,
    max_messages_per_prompt: row.max_messages_per_prompt,
    skills: JSON.parse(row.skills),
    shared_resources: JSON.parse(row.shared_resources),
    mcp_servers: JSON.parse(row.mcp_servers),
    packages_apt: JSON.parse(row.packages_apt),
    packages_npm: JSON.parse(row.packages_npm),
    additional_mounts: JSON.parse(row.additional_mounts),
    cli_scope: row.cli_scope,
    updated_at: row.updated_at,
  };
}

registerResource({
  name: 'group',
  plural: 'groups',
  table: 'agent_groups',
  description:
    'Agent group — a logical agent identity. Each group has its own workspace folder (CLAUDE.md, skills, container config), conversation history, and container image. Multiple messaging groups can be wired to one agent group.',
  idColumn: 'id',
  scopeField: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    {
      name: 'name',
      type: 'string',
      description: 'Display name shown in logs, help output, and channel adapters. Does not need to be unique.',
      required: true,
      updatable: true,
    },
    {
      name: 'folder',
      type: 'string',
      description:
        'Directory name under groups/ on the host. Must be unique. Contains CLAUDE.md, skills/, and container.json. Cannot be changed after creation.',
      required: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  // `delete` is intentionally not in `operations` — the generic single-table
  // DELETE violates FK constraints (see #2525). The cascading handler is
  // provided as `customOperations.delete` below.
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval' },
  customOperations: {
    'memory status': {
      access: 'open',
      description:
        'Show neutral-memory rollout state and effective writer ownership. Use --id <group-id>. This never reads memory bodies.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const control = getAgentGroupMemoryControl(id);
        if (!control) throw new Error(`Memory control not found for group: ${id}`);
        const sessions = getSessionsByAgentGroup(id);
        return {
          ...control,
          sessions: sessions.map((session) => ({
            id: session.id,
            status: session.status,
            container_status: session.container_status,
            memory_access:
              control.mode === 'disabled'
                ? 'none'
                : control.writer_session_id === session.id
                  ? 'read-write'
                  : 'read-only',
            active_container: isContainerRunning(session.id),
            wake_in_flight: isContainerWakeInFlight(session.id),
          })),
        };
      },
    },
    'memory writer transfer': {
      access: 'approval',
      description:
        'Transfer neutral-memory writer ownership. Requires --id <group-id>, --writer-session-id <session-id>, and --expected-version <number>. Optionally pass --expected-writer-session-id for compare-and-swap protection. The operation fences wakes and requires every group container to be stopped.',
      args: [
        {
          name: 'writer_session_id',
          type: 'string',
          description: 'Session that will become the sole private-memory writer.',
          required: true,
        },
        {
          name: 'expected_writer_session_id',
          type: 'string',
          description: 'Current writer session expected by the operator. Omit only when the current writer is null.',
        },
        {
          name: 'expected_version',
          type: 'number',
          description: 'Current memory-control version for optimistic concurrency.',
          required: true,
        },
      ],
      handler: async (args) => {
        const id = args.id as string;
        const writerSessionId = args.writer_session_id as string;
        const expectedWriterSessionId = (args.expected_writer_session_id as string | undefined) ?? null;
        const expectedVersion = Number(args.expected_version);
        if (!id) throw new Error('--id is required');
        if (!writerSessionId) throw new Error('--writer-session-id is required');
        if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
          throw new Error('--expected-version must be a positive integer');
        }

        const fenceToken = randomUUID();
        if (!acquireAgentGroupMemoryFence(id, 'ncl-memory-writer-transfer', fenceToken)) {
          throw new Error(`Memory maintenance fence is already held for group: ${id}`);
        }
        let transferResult: ReturnType<typeof transferAgentGroupMemoryWriter> | undefined;
        let transferError: unknown;
        try {
          const sessions = getSessionsByAgentGroup(id);
          await drainContainerWakes(sessions.map((session) => session.id));
          const busy = sessions.filter(
            (session) =>
              session.container_status !== 'stopped' ||
              isContainerRunning(session.id) ||
              isContainerWakeInFlight(session.id),
          );
          if (busy.length > 0) {
            throw new Error(`All group containers must be stopped before writer transfer: ${busy[0].id}`);
          }
          if (writerSessionId === expectedWriterSessionId) {
            throw new Error('New writer session must differ from the current writer');
          }
          transferResult = transferAgentGroupMemoryWriter(
            id,
            expectedVersion,
            expectedWriterSessionId,
            writerSessionId,
          );
          // eslint-disable-next-line no-catch-all/no-catch-all -- defer rethrow until the temporary fence is released
        } catch (err) {
          transferError = err;
        }
        if (!releaseAgentGroupMemoryFence(id, fenceToken)) {
          throw new Error(`Failed to release memory maintenance fence for group: ${id}`, {
            cause: transferError,
          });
        }
        if (transferError) throw transferError;
        return transferResult!;
      },
    },
    delete: {
      access: 'approval',
      description:
        'Delete an agent group and its dependent rows (sessions, destinations, approvals, role grants, ' +
        'memberships, channel wirings). FK-ordered cascade in a single transaction. ' +
        'Use --id <group-id>. Out of scope: killing running containers, on-disk cleanup of groups/<folder>/ and data/v2-sessions/<group-id>/.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const db = getDb();

        // Verify the group exists before doing anything — preserves the
        // genericDelete behaviour of throwing "not found" for unknown IDs.
        const exists = db.prepare('SELECT 1 FROM agent_groups WHERE id = ? LIMIT 1').get(id);
        if (!exists) throw new Error(`group not found: ${id}`);

        const hasAgentDestinations = hasTable(db, 'agent_destinations');
        const hasPendingApprovals = hasTable(db, 'pending_approvals');

        // FK-ordered cascade. Single sync transaction — better-sqlite3 rolls
        // back the whole thing if any statement throws (e.g. an FK constraint
        // we missed), so the central DB stays consistent. The `removed` counts
        // are sourced from each DELETE's `changes` so they describe exactly
        // what the transaction did, not a separate pre-flight snapshot.
        const cascade = db.transaction((groupId: string) => {
          const counts = {
            sessions: 0,
            pending_questions: 0,
            pending_approvals: 0,
            agent_destinations_owned: 0,
            agent_destinations_pointing: 0,
            pending_sender_approvals: 0,
            pending_channel_approvals: 0,
            messaging_group_agents: 0,
            agent_group_members: 0,
            user_roles: 0,
            container_configs: 0,
          };

          if (hasAgentDestinations) {
            counts.agent_destinations_owned = db
              .prepare('DELETE FROM agent_destinations WHERE agent_group_id = ?')
              .run(groupId).changes;
            counts.agent_destinations_pointing = db
              .prepare('DELETE FROM agent_destinations WHERE target_type = ? AND target_id = ?')
              .run('agent', groupId).changes;
          }
          counts.pending_questions = db
            .prepare(
              'DELETE FROM pending_questions WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
            )
            .run(groupId).changes;
          if (hasPendingApprovals) {
            counts.pending_approvals = db
              .prepare(
                'DELETE FROM pending_approvals WHERE agent_group_id = ? OR session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
              )
              .run(groupId, groupId).changes;
          }
          counts.sessions = db.prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(groupId).changes;
          counts.pending_sender_approvals = db
            .prepare('DELETE FROM pending_sender_approvals WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.pending_channel_approvals = db
            .prepare('DELETE FROM pending_channel_approvals WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.messaging_group_agents = db
            .prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.agent_group_members = db
            .prepare('DELETE FROM agent_group_members WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.user_roles = db.prepare('DELETE FROM user_roles WHERE agent_group_id = ?').run(groupId).changes;
          // migration-014 has ON DELETE CASCADE on container_configs.agent_group_id;
          // the explicit delete here mirrors the other tables and surfaces the count.
          counts.container_configs = db
            .prepare('DELETE FROM container_configs WHERE agent_group_id = ?')
            .run(groupId).changes;
          db.prepare('DELETE FROM agent_groups WHERE id = ?').run(groupId);
          return counts;
        });
        const removed = cascade(id);

        return { deleted: id, removed };
      },
    },
    restart: {
      access: 'approval',
      description:
        'Restart containers for a group. Use --id <group-id> [--rebuild] [--message <text>]. ' +
        'From inside a container, --id is auto-filled and only the calling session is restarted. ' +
        '--rebuild rebuilds the container image first (required for package changes). ' +
        '--message sets an on-wake instruction for the fresh container to act on when it starts — ' +
        'use this when you need to continue after the restart (e.g. verify a new tool works, notify the user). ' +
        'Without --message, the container stops and only starts again on the next user message.',
      handler: async (args, ctx) => {
        const id = (args.id as string) || (ctx.caller === 'agent' ? ctx.agentGroupId : undefined);
        if (!id) throw new Error('--id is required');
        if (args.rebuild) {
          await buildAgentGroupImage(id);
        }
        const message = args.message as string | undefined;

        // From an agent: scope to the calling session only
        if (ctx.caller === 'agent') {
          if (message) {
            writeSessionMessage(id, ctx.sessionId, {
              id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              kind: 'chat',
              timestamp: new Date().toISOString(),
              platformId: id,
              channelType: 'agent',
              threadId: null,
              content: JSON.stringify({ text: message, sender: 'system', senderId: 'system' }),
              onWake: 1,
            });
          }
          killContainer(
            ctx.sessionId,
            'restarted via ncl',
            message
              ? () => {
                  const s = getSession(ctx.sessionId);
                  if (s) wakeContainer(s);
                }
              : undefined,
          );
          return { restarted: 1, rebuilt: !!args.rebuild };
        }

        // From the host: restart all running containers in the group
        const count = restartAgentGroupContainers(id, 'restarted via ncl', message);
        return { restarted: count, rebuilt: !!args.rebuild };
      },
    },
    'config get': {
      access: 'open',
      description: 'Show the container config for a group. Use --id <group-id>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);
        return presentConfig(row);
      },
    },
    'config update': {
      access: 'approval',
      description:
        'Update container config scalar fields. Changes are saved but do NOT take effect until you run `ncl groups restart`. ' +
        'Use --id <group-id> and any of: --provider, --provider-profile, --model, --effort, --image-tag, --assistant-name, --max-messages-per-prompt, --cli-scope.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const updates: Partial<
          Pick<
            ContainerConfigRow,
            | 'provider_profile_id'
            | 'provider'
            | 'model'
            | 'effort'
            | 'image_tag'
            | 'assistant_name'
            | 'max_messages_per_prompt'
            | 'cli_scope'
          >
        > = {};
        const profileArg = (args['provider-profile'] ?? args.provider_profile) as string | undefined;
        if (args.provider !== undefined && profileArg !== undefined) {
          throw new Error('--provider and --provider-profile cannot be used together');
        }
        if (args.provider !== undefined) {
          const descriptor = requireProviderDescriptor(args.provider as string);
          updates.provider = descriptor.runtime.containerProviderName;
          updates.provider_profile_id = null;
        }
        if (profileArg !== undefined) {
          const profile = getProviderProfile(profileArg);
          if (!profile) throw new Error(`Provider profile not found: ${profileArg}`);
          if (profile.enabled !== 1) throw new Error(`Provider profile is disabled: ${profile.name}`);
          const descriptor = requireProviderDescriptor(profile.provider_name);
          updates.provider_profile_id = profile.id;
          updates.provider = descriptor.runtime.containerProviderName;
        }
        if (args.model !== undefined) updates.model = args.model as string;
        if (args.effort !== undefined) updates.effort = args.effort as string;
        if (args.image_tag !== undefined) updates.image_tag = args.image_tag as string;
        if (args.assistant_name !== undefined) updates.assistant_name = args.assistant_name as string;
        if (args.max_messages_per_prompt !== undefined)
          updates.max_messages_per_prompt = Number(args.max_messages_per_prompt);
        if (args['cli-scope'] !== undefined || args.cli_scope !== undefined) {
          const scope = (args['cli-scope'] ?? args.cli_scope) as string;
          if (!['disabled', 'group', 'global'].includes(scope)) {
            throw new Error('--cli-scope must be one of: disabled, group, global');
          }
          updates.cli_scope = scope;
        }

        if (Object.keys(updates).length === 0) {
          throw new Error(
            'Nothing to update — provide at least one of: --provider, --provider-profile, --model, --effort, --image-tag, --assistant-name, --max-messages-per-prompt, --cli-scope',
          );
        }

        updateContainerConfigScalars(id, updates);

        const updated = getContainerConfig(id)!;
        return presentConfig(updated);
      },
    },
    'config add-mcp-server': {
      access: 'approval',
      description:
        'Add an MCP server to a group. Requires `ncl groups restart` to take effect. ' +
        'Use --id <group-id> --name <server-name> --command <cmd> [--args <json-array>] [--env <json-object>].',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');
        const command = args.command as string;
        if (!command) throw new Error('--command is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
        servers[name] = {
          command,
          args: args.args ? (JSON.parse(args.args as string) as string[]) : [],
          env: args.env ? (JSON.parse(args.env as string) as Record<string, string>) : {},
        };
        updateContainerConfigJson(id, 'mcp_servers', servers);

        return { added: name, servers };
      },
    },
    'config remove-mcp-server': {
      access: 'approval',
      description:
        'Remove an MCP server from a group. Requires `ncl groups restart` to take effect. Use --id <group-id> --name <server-name>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
        if (!servers[name]) throw new Error(`MCP server "${name}" not found`);
        delete servers[name];
        updateContainerConfigJson(id, 'mcp_servers', servers);

        return { removed: name };
      },
    },

    'config set-shared-resources': {
      access: 'approval',
      description:
        'Set the full list of shared resources (groups/shared/<name>, plus "docs" for repo docs). ' +
        'Requires `ncl groups restart` to take effect. Use --id <group-id> --shared-resources <json-array|none>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const raw = (args['shared-resources'] ?? args.shared_resources) as string | undefined;
        if (raw === undefined) throw new Error('--shared-resources is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        let resources: string[];
        if (raw.trim().toLowerCase() === 'none') {
          resources = [];
        } else {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            throw new Error('--shared-resources must be "none" or a JSON array of strings', { cause: error });
          }
          if (!Array.isArray(parsed) || !parsed.every((r) => typeof r === 'string')) {
            throw new Error('--shared-resources must be "none" or a JSON array of strings');
          }
          resources = [];
          for (const resource of parsed) {
            const trimmed = resource.trim();
            if (!trimmed) throw new Error('--shared-resources entries must be non-empty strings');
            if (!resources.includes(trimmed)) resources.push(trimmed);
          }
        }

        updateContainerConfigJson(id, 'shared_resources', resources);
        return presentConfig(getContainerConfig(id)!);
      },
    },
    'config add-package': {
      access: 'approval',
      description:
        'Add a package to a group. Requires `ncl groups restart --rebuild` to take effect. Use --id <group-id> and --apt <pkg> or --npm <pkg>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const apt = args.apt as string | undefined;
        const npm = args.npm as string | undefined;
        if (!apt && !npm) throw new Error('Provide --apt <pkg> or --npm <pkg>');
        if (apt) validatePackageName('apt', apt);
        if (npm) validatePackageName('npm', npm);

        if (apt) {
          const existing = JSON.parse(row.packages_apt) as string[];
          if (!existing.includes(apt)) {
            existing.push(apt);
            updateContainerConfigJson(id, 'packages_apt', existing);
          }
        }
        if (npm) {
          const existing = JSON.parse(row.packages_npm) as string[];
          if (!existing.includes(npm)) {
            existing.push(npm);
            updateContainerConfigJson(id, 'packages_npm', existing);
          }
        }

        return {
          added: { apt: apt || null, npm: npm || null },
          note: 'Image rebuild required for packages to take effect. Use install_packages from the agent or rebuild manually.',
        };
      },
    },
    'config remove-package': {
      access: 'approval',
      description:
        'Remove a package from a group. Requires `ncl groups restart --rebuild` to take effect. Use --id <group-id> and --apt <pkg> or --npm <pkg>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const apt = args.apt as string | undefined;
        const npm = args.npm as string | undefined;
        if (!apt && !npm) throw new Error('Provide --apt <pkg> or --npm <pkg>');

        if (apt) {
          const existing = JSON.parse(row.packages_apt) as string[];
          const filtered = existing.filter((p) => p !== apt);
          updateContainerConfigJson(id, 'packages_apt', filtered);
        }
        if (npm) {
          const existing = JSON.parse(row.packages_npm) as string[];
          const filtered = existing.filter((p) => p !== npm);
          updateContainerConfigJson(id, 'packages_npm', filtered);
        }

        return {
          removed: { apt: apt || null, npm: npm || null },
          note: 'Image rebuild required for package changes to take effect.',
        };
      },
    },
  },
});
