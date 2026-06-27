import { getContainerConfig } from '../../db/container-configs.js';
import {
  createProviderProfile,
  getProviderProfile,
  listProviderProfiles,
  setProviderProfileEnabled,
} from '../../db/provider-profiles.js';
import '../../providers/descriptors/index.js';
import { listProviderDescriptors } from '../../providers/provider-descriptor-registry.js';
import { verifyProviderProfile } from '../../providers/provider-verifier-registry.js';
import type { CallerContext } from '../frame.js';
import { registerResource } from '../crud.js';

function requireGlobal(ctx: CallerContext): void {
  if (ctx.caller === 'host') return;
  const config = getContainerConfig(ctx.agentGroupId);
  if (config?.cli_scope !== 'global') throw new Error('Provider profiles require global CLI scope');
}

function redactedProfile(profile: ReturnType<typeof listProviderProfiles>[number]): Record<string, unknown> {
  return {
    id: profile.id,
    name: profile.name,
    provider_name: profile.provider_name,
    protocol: profile.protocol,
    base_url: profile.base_url,
    api_family: profile.api_family,
    tool_strategy: profile.tool_strategy,
    default_model: profile.default_model,
    default_effort: profile.default_effort,
    auth_mode: profile.auth_mode,
    auth_configured: Boolean(profile.auth_ref) || profile.auth_mode === 'none',
    enabled: profile.enabled === 1,
    updated_at: profile.updated_at,
  };
}

registerResource({
  name: 'provider',
  plural: 'providers',
  table: 'provider_profiles',
  description: 'Installed provider descriptors and local provider profiles.',
  idColumn: 'id',
  columns: [{ name: 'id', type: 'string', description: 'Provider profile ID.', generated: true }],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List installed provider descriptors. Does not expose credentials.',
      handler: async () =>
        listProviderDescriptors().map((descriptor) => ({
          name: descriptor.name,
          display_name: descriptor.displayName,
          protocol: descriptor.protocol,
          installed_by: descriptor.installedBy,
          container_provider: descriptor.runtime.containerProviderName,
          setup_selectable: descriptor.setup?.selectable === true,
          capabilities: descriptor.capabilities,
        })),
    },
    profiles: {
      access: 'open',
      description: 'List configured provider profiles (global operators only; auth references are redacted).',
      handler: async (_args, ctx) => {
        requireGlobal(ctx);
        return listProviderProfiles().map(redactedProfile);
      },
    },
    'create-openai-compatible': {
      access: 'approval',
      description:
        'Create an OpenAI-compatible profile. Requires --name, --base-url, --api-family, --model, --auth-mode and optional --auth-ref.',
      handler: async (args, ctx) => {
        requireGlobal(ctx);
        const name = args.name as string;
        const baseUrl = (args['base-url'] ?? args.base_url) as string;
        const apiFamily = (args['api-family'] ?? args.api_family) as 'responses' | 'chat-completions';
        const model = args.model as string;
        const authMode = (args['auth-mode'] ?? args.auth_mode) as 'onecli-secret' | 'none';
        if (!name || !baseUrl || !apiFamily || !model || !authMode) {
          throw new Error('--name, --base-url, --api-family, --model, and --auth-mode are required');
        }
        const profile = createProviderProfile({
          name,
          providerName: 'openai-compatible',
          baseUrl,
          apiFamily,
          defaultModel: model,
          authMode,
          authRef: (args['auth-ref'] ?? args.auth_ref) as string | undefined,
          allowInsecureHttp: args['allow-insecure-http'] === true || args.allow_insecure_http === true,
        });
        return redactedProfile(profile);
      },
    },
    enable: {
      access: 'approval',
      description: 'Enable a provider profile. Use --id <profile-id-or-name>.',
      handler: async (args, ctx) => {
        requireGlobal(ctx);
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        return redactedProfile(setProviderProfileEnabled(id, true));
      },
    },
    disable: {
      access: 'approval',
      description: 'Disable a provider profile. Use --id <profile-id-or-name>.',
      handler: async (args, ctx) => {
        requireGlobal(ctx);
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        return redactedProfile(setProviderProfileEnabled(id, false));
      },
    },
    get: {
      access: 'open',
      description: 'Show a redacted provider profile. Use --id <profile-id-or-name>.',
      handler: async (args, ctx) => {
        requireGlobal(ctx);
        const profile = getProviderProfile(args.id as string);
        if (!profile) throw new Error(`Provider profile not found: ${String(args.id)}`);
        return redactedProfile(profile);
      },
    },
    verify: {
      access: 'approval',
      description:
        'Verify a provider profile through its runtime credential path. Requires --id and optional --agent-group-id.',
      handler: async (args, ctx) => {
        requireGlobal(ctx);
        const profile = getProviderProfile(args.id as string);
        if (!profile) throw new Error(`Provider profile not found: ${String(args.id)}`);
        return verifyProviderProfile(profile, {
          agentGroupId: (args['agent-group-id'] ?? args.agent_group_id) as string | undefined,
        });
      },
    },
  },
});
