import { hostIntegrationAdministration } from '../../integrations/administration.js';
import type { CallerContext } from '../frame.js';
import { registerResource } from '../crud.js';

function requireHost(ctx: CallerContext): void {
  if (ctx.caller !== 'host') throw new Error('Integration management is available only to the host operator');
}

const profileTarget = {
  name: 'id',
  type: 'string' as const,
  description: 'Profile ID or non-sensitive profile name. Usually supplied positionally.',
};
const expectedVersion = {
  name: 'expected_version',
  type: 'number' as const,
  required: true,
  description: 'Current profile version used for optimistic concurrency control.',
};

registerResource({
  name: 'integration',
  plural: 'integrations',
  table: 'integration_profiles',
  description: 'Host-only trusted-host integration profiles, grants, and credentials.',
  idColumn: 'id',
  hostOnly: true,
  columns: [{ name: 'id', type: 'string', description: 'Integration profile ID.', generated: true }],
  operations: {},
  customOperations: {
    list: {
      access: 'hidden',
      description: 'List redacted integration profiles (host only).',
      args: [],
      handler: async (_args, ctx) => {
        requireHost(ctx);
        return hostIntegrationAdministration.list();
      },
    },
    get: {
      access: 'hidden',
      description: 'Show one redacted integration profile (host only).',
      args: [profileTarget],
      examples: ['ncl integrations get <profile>'],
      handler: async (args, ctx) => {
        requireHost(ctx);
        return hostIntegrationAdministration.get(requireTarget(args));
      },
    },
    create: {
      access: 'hidden',
      description: 'Create a disabled profile from non-secret configuration (host only).',
      args: [
        { name: 'name', type: 'string', required: true, description: 'Non-sensitive profile label.' },
        { name: 'adapter', type: 'string', required: true, description: 'Registered adapter ID.' },
        { name: 'adapter_version', type: 'number', required: true, description: 'Exact registered adapter version.' },
        { name: 'config', type: 'json', required: true, description: 'Adapter-owned non-secret JSON configuration.' },
        {
          name: 'credential_backend',
          type: 'string',
          required: true,
          enum: ['local-file', 'systemd'],
          description: 'Credential backend. systemd is reserved and unsupported in v1.',
        },
      ],
      examples: [
        'ncl integrations create --name portal --adapter portal-adapter --adapter-version 1 --config \'{"tenant":"example"}\' --credential-backend local-file',
      ],
      handler: async (args, ctx) => {
        requireHost(ctx);
        return hostIntegrationAdministration.create({
          name: args.name as string,
          adapterId: args.adapter as string,
          adapterVersion: args.adapter_version as number,
          config: args.config,
          credentialBackend: args.credential_backend as 'local-file' | 'systemd',
        });
      },
    },
    update: {
      access: 'hidden',
      description: 'Update non-secret profile metadata with an expected version (host only).',
      args: [
        profileTarget,
        expectedVersion,
        { name: 'name', type: 'string', description: 'Replacement non-sensitive profile label.' },
        { name: 'config', type: 'json', description: 'Replacement adapter-owned non-secret JSON configuration.' },
      ],
      examples: ['ncl integrations update <profile> --expected-version 1 --config \'{"tenant":"example"}\''],
      handler: async (args, ctx) => {
        requireHost(ctx);
        return hostIntegrationAdministration.update(requireTarget(args), args.expected_version as number, {
          name: args.name as string | undefined,
          config: args.config,
        });
      },
    },
    grant: {
      access: 'hidden',
      description: 'Grant one registered read-only operation to an agent group (host only).',
      args: [
        profileTarget,
        { name: 'group', type: 'string', required: true, description: 'Agent group ID.' },
        { name: 'operation', type: 'string', required: true, description: 'Registered adapter operation.' },
      ],
      examples: ['ncl integrations grant <profile> --group <group-id> --operation records.read'],
      handler: async (args, ctx) => {
        requireHost(ctx);
        return hostIntegrationAdministration.grant(requireTarget(args), args.group as string, args.operation as string);
      },
    },
    'revoke-grant': {
      access: 'hidden',
      description: 'Revoke one integration operation grant (host only).',
      args: [
        profileTarget,
        { name: 'group', type: 'string', required: true, description: 'Agent group ID.' },
        { name: 'operation', type: 'string', required: true, description: 'Registered adapter operation.' },
      ],
      examples: ['ncl integrations revoke-grant <profile> --group <group-id> --operation records.read'],
      handler: async (args, ctx) => {
        requireHost(ctx);
        return hostIntegrationAdministration.revokeGrant(
          requireTarget(args),
          args.group as string,
          args.operation as string,
        );
      },
    },
    grants: {
      access: 'hidden',
      description: 'List grants for one profile (host only).',
      args: [profileTarget],
      examples: ['ncl integrations grants <profile>'],
      handler: async (args, ctx) => {
        requireHost(ctx);
        return hostIntegrationAdministration.grants(requireTarget(args));
      },
    },
    enable: {
      access: 'hidden',
      description: 'Validate the stored credential payload and enable a profile (host only).',
      args: [profileTarget, expectedVersion],
      examples: ['ncl integrations enable <profile> --expected-version 1'],
      handler: async (args, ctx) => {
        requireHost(ctx);
        return hostIntegrationAdministration.enable(requireTarget(args), args.expected_version as number);
      },
    },
    disable: {
      access: 'hidden',
      description: 'Disable a profile with an expected version (host only).',
      args: [profileTarget, expectedVersion],
      examples: ['ncl integrations disable <profile> --expected-version 2'],
      handler: async (args, ctx) => {
        requireHost(ctx);
        return hostIntegrationAdministration.disable(requireTarget(args), args.expected_version as number);
      },
    },
    test: {
      access: 'hidden',
      description: 'Revalidate stored credential safety and adapter schema without contacting upstream (host only).',
      args: [profileTarget],
      examples: ['ncl integrations test <profile>'],
      handler: async (args, ctx) => {
        requireHost(ctx);
        return hostIntegrationAdministration.test(requireTarget(args));
      },
    },
    'credential schema': {
      access: 'hidden',
      description: 'Internal host-client credential prompt schema. Returns field metadata only.',
      args: [profileTarget],
      handler: async (args, ctx) => {
        requireHost(ctx);
        return hostIntegrationAdministration.credentialSchema(requireTarget(args));
      },
    },
    'credential set': {
      access: 'hidden',
      description: 'Store a new credential from the host client protected-input channel.',
      args: [
        profileTarget,
        {
          name: 'protected_payload',
          type: 'json',
          required: true,
          hidden: true,
          description: 'Internal protected payload; never pass this as a command-line flag.',
        },
      ],
      handler: async (args, ctx) => {
        requireHost(ctx);
        return hostIntegrationAdministration.setCredential(requireTarget(args), args.protected_payload, 'set');
      },
    },
    'credential rotate': {
      access: 'hidden',
      description: 'Atomically rotate a credential from the host client protected-input channel.',
      args: [
        profileTarget,
        {
          name: 'protected_payload',
          type: 'json',
          required: true,
          hidden: true,
          description: 'Internal protected payload; never pass this as a command-line flag.',
        },
      ],
      handler: async (args, ctx) => {
        requireHost(ctx);
        return hostIntegrationAdministration.setCredential(requireTarget(args), args.protected_payload, 'rotate');
      },
    },
    'credential revoke': {
      access: 'hidden',
      description: 'Disable the profile, then remove its local credential (host only).',
      args: [profileTarget, expectedVersion],
      examples: ['ncl integrations credential revoke <profile> --expected-version 2'],
      handler: async (args, ctx) => {
        requireHost(ctx);
        return hostIntegrationAdministration.revokeCredential(requireTarget(args), args.expected_version as number);
      },
    },
  },
});

function requireTarget(args: Record<string, unknown>): string {
  if (typeof args.id !== 'string' || !args.id.trim()) throw new Error('Profile ID or name is required');
  return args.id;
}
