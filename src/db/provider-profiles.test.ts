import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from './agent-groups.js';
import { closeDb, getDb, initTestDb } from './connection.js';
import { createContainerConfig, updateContainerConfigScalars } from './container-configs.js';
import { runMigrations } from './migrations/index.js';
import {
  createProviderProfile,
  deleteProviderProfile,
  getProviderProfile,
  listProviderProfiles,
  setProviderProfileEnabled,
} from './provider-profiles.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => closeDb());

describe('provider profiles', () => {
  it('creates, lists, and disables a validated native profile', () => {
    const profile = createProviderProfile({
      id: 'profile-claude',
      name: 'Claude default',
      providerName: 'claude',
      authMode: 'oauth',
      defaultModel: 'claude-sonnet-4-5',
    });
    expect(profile.protocol).toBe('native');
    expect(listProviderProfiles()).toHaveLength(1);
    expect(setProviderProfileEnabled(profile.id, false).enabled).toBe(0);
    expect(getProviderProfile('Claude default')?.id).toBe(profile.id);
  });

  it('creates a generic endpoint profile without storing credential values', () => {
    const profile = createProviderProfile({
      id: 'profile-generic',
      name: 'Local gateway',
      providerName: 'openai-compatible',
      baseUrl: 'https://models.example.test/v1',
      apiFamily: 'responses',
      defaultModel: 'example/model',
      authMode: 'onecli-secret',
      authRef: 'Example Models',
    });
    expect(profile).toMatchObject({
      provider_name: 'openai-compatible',
      protocol: 'openai-compatible',
      base_url: 'https://models.example.test/v1',
      api_family: 'responses',
      auth_ref: 'Example Models',
    });
    expect(JSON.stringify(profile)).not.toContain('Bearer ');
  });

  it('rejects unsafe endpoint and mismatched protocol settings', () => {
    expect(() =>
      createProviderProfile({
        name: 'bad',
        providerName: 'claude',
        protocol: 'openai-compatible',
        baseUrl: 'http://169.254.169.254/latest?token=x',
        authMode: 'oauth',
      }),
    ).toThrow(/does not match/);
  });

  it('allows capability downgrades but rejects unverified capability elevation', () => {
    const downgraded = createProviderProfile({
      name: 'Restricted Claude',
      providerName: 'claude',
      authMode: 'oauth',
      capabilityOverrides: {
        streaming: false,
        mcp: 'none',
        media: { images: 'unsupported' },
      },
    });
    expect(JSON.parse(downgraded.capability_overrides)).toMatchObject({
      streaming: false,
      mcp: 'none',
      media: { images: 'unsupported' },
    });

    expect(() =>
      createProviderProfile({
        name: 'Overstated generic provider',
        providerName: 'openai-compatible',
        baseUrl: 'https://models.example.test/v1',
        apiFamily: 'responses',
        defaultModel: 'example-model',
        authMode: 'none',
        capabilityOverrides: { mcp: 'native' },
      }),
    ).toThrow(/cannot elevate capability: mcp/);
  });

  it('refuses deletion while assigned and permits it after reassignment', () => {
    const profile = createProviderProfile({
      id: 'profile-claude',
      name: 'Claude default',
      providerName: 'claude',
      authMode: 'oauth',
    });
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      folder: 'agent',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    createContainerConfig({
      agent_group_id: 'ag-1',
      provider_profile_id: profile.id,
      provider: 'claude',
      model: null,
      effort: null,
      image_tag: null,
      assistant_name: null,
      max_messages_per_prompt: null,
      skills: '"all"',
      mcp_servers: '{}',
      packages_apt: '[]',
      packages_npm: '[]',
      additional_mounts: '[]',
      cli_scope: 'group',
      shared_resources: '[]',
      updated_at: new Date().toISOString(),
    });
    expect(() => deleteProviderProfile(profile.id)).toThrow(/assigned/);
    updateContainerConfigScalars('ag-1', { provider_profile_id: null });
    deleteProviderProfile(profile.id);
    expect(getProviderProfile(profile.id)).toBeUndefined();
  });

  it('adds nullable profile references without backfilling existing selections', () => {
    const columns = getDb().prepare("PRAGMA table_info('container_configs')").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('provider_profile_id');
  });
});
