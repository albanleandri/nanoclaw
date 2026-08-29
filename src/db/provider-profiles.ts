import { createHash, randomUUID } from 'crypto';

import type { ProviderCapabilities, ProviderProtocol } from '../providers/provider-descriptor.js';
import '../providers/descriptors/index.js';
import { requireProviderDescriptor } from '../providers/provider-descriptor-registry.js';
import type { ProviderProfileRow } from '../types.js';
import { getDb } from './connection.js';

const API_FAMILIES = new Set(['responses', 'chat-completions']);
const OVERRIDE_KEYS = new Set<keyof ProviderCapabilities>([
  'streaming',
  'mcp',
  'toolCalling',
  'continuation',
  'followUpMode',
  'structuredOutput',
  'media',
  'reviewMode',
]);
const CAPABILITY_ORDER = {
  mcp: ['none', 'stdio-adapter', 'native'],
  toolCalling: ['none', 'prompt-mediated', 'native'],
  continuation: ['none', 'stateless', 'provider-thread', 'durable'],
  followUpMode: ['unsupported', 'queue-turns', 'push-active-turn'],
  structuredOutput: ['none', 'best-effort', 'strict'],
  media: ['unsupported', 'file-reference', 'native'],
} as const;

export interface ProviderProfileInput {
  id?: string;
  name: string;
  providerName: string;
  protocol?: ProviderProtocol;
  baseUrl?: string | null;
  apiFamily?: 'responses' | 'chat-completions' | null;
  toolStrategy?: 'none';
  defaultModel?: string | null;
  defaultEffort?: string | null;
  authMode: string;
  authRef?: string | null;
  capabilityOverrides?: ProviderCapabilityOverrides;
  allowInsecureHttp?: boolean;
  enabled?: boolean;
}

export type ProviderCapabilityOverrides = Omit<Partial<ProviderCapabilities>, 'media' | 'reviewMode'> & {
  media?: Partial<ProviderCapabilities['media']>;
  reviewMode?: Partial<ProviderCapabilities['reviewMode']>;
};

export interface VerifiedToolProbe {
  profileId: string;
  fingerprint: string;
  verifiedAt: string;
  ok: boolean;
}

export function providerToolFingerprint(
  profile: Pick<ProviderProfileRow, 'provider_name' | 'protocol' | 'base_url' | 'api_family' | 'default_model'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        provider: profile.provider_name,
        protocol: profile.protocol,
        baseUrl: profile.base_url,
        apiFamily: profile.api_family,
        model: profile.default_model,
      }),
    )
    .digest('hex');
}

function normalizeBaseUrl(value: string | null | undefined, allowInsecureHttp: boolean): string | null {
  if (!value) return null;
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Provider base URL cannot contain userinfo, query parameters, or fragments');
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
    throw new Error('Provider base URL targets a blocked metadata endpoint');
  }
  if (url.protocol !== 'https:' && !(allowInsecureHttp && url.protocol === 'http:')) {
    throw new Error('Provider base URL must use HTTPS unless insecure HTTP is explicitly enabled');
  }
  return url.toString().replace(/\/$/, '');
}

function assertNoElevation<T extends string>(field: string, baseline: T, override: unknown, order: readonly T[]): void {
  if (override === undefined) return;
  if (typeof override !== 'string' || !order.includes(override as T)) {
    throw new Error(`Invalid provider capability override: ${field}`);
  }
  if (order.indexOf(override as T) > order.indexOf(baseline)) {
    throw new Error(`Unverified provider profile cannot elevate capability: ${field}`);
  }
}

function assertBooleanDowngrade(field: string, baseline: boolean, override: unknown): void {
  if (override === undefined) return;
  if (typeof override !== 'boolean') throw new Error(`Invalid provider capability override: ${field}`);
  if (!baseline && override) throw new Error(`Unverified provider profile cannot elevate capability: ${field}`);
}

function validateOverrides(defaults: ProviderCapabilities, value: ProviderCapabilityOverrides | undefined): string {
  const overrides = value ?? {};
  for (const key of Object.keys(overrides)) {
    if (!OVERRIDE_KEYS.has(key as keyof ProviderCapabilities)) {
      throw new Error(`Unknown provider capability override: ${key}`);
    }
  }
  assertBooleanDowngrade('streaming', defaults.streaming, overrides.streaming);
  assertNoElevation('mcp', defaults.mcp, overrides.mcp, CAPABILITY_ORDER.mcp);
  assertNoElevation('toolCalling', defaults.toolCalling, overrides.toolCalling, CAPABILITY_ORDER.toolCalling);
  assertNoElevation('continuation', defaults.continuation, overrides.continuation, CAPABILITY_ORDER.continuation);
  assertNoElevation('followUpMode', defaults.followUpMode, overrides.followUpMode, CAPABILITY_ORDER.followUpMode);
  assertNoElevation(
    'structuredOutput',
    defaults.structuredOutput,
    overrides.structuredOutput,
    CAPABILITY_ORDER.structuredOutput,
  );
  if (overrides.media !== undefined) {
    if (!overrides.media || typeof overrides.media !== 'object') {
      throw new Error('Invalid provider capability override: media');
    }
    for (const key of Object.keys(overrides.media)) {
      if (!['images', 'pdfs', 'audio'].includes(key)) {
        throw new Error(`Unknown provider capability override: media.${key}`);
      }
    }
    assertNoElevation('media.images', defaults.media.images, overrides.media.images, CAPABILITY_ORDER.media);
    assertNoElevation('media.pdfs', defaults.media.pdfs, overrides.media.pdfs, CAPABILITY_ORDER.media);
    assertNoElevation('media.audio', defaults.media.audio, overrides.media.audio, CAPABILITY_ORDER.media);
  }
  if (overrides.reviewMode !== undefined) {
    if (!overrides.reviewMode || typeof overrides.reviewMode !== 'object') {
      throw new Error('Invalid provider capability override: reviewMode');
    }
    for (const key of Object.keys(overrides.reviewMode)) {
      if (!['readOnly', 'isolatedWorkspace'].includes(key)) {
        throw new Error(`Unknown provider capability override: reviewMode.${key}`);
      }
    }
    assertBooleanDowngrade('reviewMode.readOnly', defaults.reviewMode.readOnly, overrides.reviewMode.readOnly);
    assertBooleanDowngrade(
      'reviewMode.isolatedWorkspace',
      defaults.reviewMode.isolatedWorkspace,
      overrides.reviewMode.isolatedWorkspace,
    );
  }
  return JSON.stringify(overrides);
}

function validated(input: ProviderProfileInput): Omit<ProviderProfileRow, 'created_at' | 'updated_at'> {
  const descriptor = requireProviderDescriptor(input.providerName);
  const protocol = input.protocol ?? descriptor.protocol;
  if (protocol !== descriptor.protocol) {
    throw new Error(`Profile protocol ${protocol} does not match provider ${descriptor.name} (${descriptor.protocol})`);
  }
  if (!descriptor.auth.modes.includes(input.authMode as never)) {
    throw new Error(`Provider ${descriptor.name} does not support auth mode: ${input.authMode}`);
  }
  if (input.authMode !== 'none' && !input.authRef?.trim() && descriptor.name === 'openai-compatible') {
    throw new Error('Authenticated generic provider profiles require an auth reference');
  }
  if (protocol === 'openai-compatible' && !input.apiFamily) {
    throw new Error('OpenAI-compatible profiles require an API family');
  }
  if (input.apiFamily && !API_FAMILIES.has(input.apiFamily)) throw new Error(`Invalid API family: ${input.apiFamily}`);
  if ((input.toolStrategy ?? 'none') !== 'none') throw new Error('Only tool_strategy=none is currently supported');
  if (descriptor.models.modelIdPattern && input.defaultModel) {
    if (!new RegExp(descriptor.models.modelIdPattern).test(input.defaultModel)) {
      throw new Error(`Invalid model ID for provider ${descriptor.name}`);
    }
  }
  return {
    id: input.id ?? randomUUID(),
    name: input.name.trim(),
    provider_name: descriptor.name,
    protocol,
    base_url: normalizeBaseUrl(input.baseUrl, input.allowInsecureHttp === true),
    api_family: input.apiFamily ?? null,
    tool_strategy: input.toolStrategy ?? 'none',
    default_model: input.defaultModel?.trim() || null,
    default_effort: input.defaultEffort?.trim() || null,
    auth_mode: input.authMode,
    auth_ref: input.authRef?.trim() || null,
    capability_overrides: validateOverrides(descriptor.capabilities, input.capabilityOverrides),
    allow_insecure_http: input.allowInsecureHttp ? 1 : 0,
    enabled: input.enabled === false ? 0 : 1,
  };
}

export function createProviderProfile(input: ProviderProfileInput): ProviderProfileRow {
  const profile = validated(input);
  if (!profile.name) throw new Error('Provider profile name is required');
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO provider_profiles (
        id, name, provider_name, protocol, base_url, api_family, tool_strategy,
        default_model, default_effort, auth_mode, auth_ref, capability_overrides,
        allow_insecure_http, enabled, created_at, updated_at
      ) VALUES (
        @id, @name, @provider_name, @protocol, @base_url, @api_family, @tool_strategy,
        @default_model, @default_effort, @auth_mode, @auth_ref, @capability_overrides,
        @allow_insecure_http, @enabled, @created_at, @updated_at
      )`,
    )
    .run({ ...profile, created_at: now, updated_at: now });
  return getProviderProfile(profile.id)!;
}

export function getProviderProfile(idOrName: string): ProviderProfileRow | undefined {
  return getDb().prepare('SELECT * FROM provider_profiles WHERE id = ? OR name = ? LIMIT 1').get(idOrName, idOrName) as
    ProviderProfileRow | undefined;
}

export function listProviderProfiles(): ProviderProfileRow[] {
  return getDb().prepare('SELECT * FROM provider_profiles ORDER BY name').all() as ProviderProfileRow[];
}

export function setProviderProfileEnabled(idOrName: string, enabled: boolean): ProviderProfileRow {
  const profile = getProviderProfile(idOrName);
  if (!profile) throw new Error(`Provider profile not found: ${idOrName}`);
  getDb()
    .prepare('UPDATE provider_profiles SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, new Date().toISOString(), profile.id);
  return getProviderProfile(profile.id)!;
}

export function activateVerifiedToolStrategy(
  idOrName: string,
  strategy: 'native',
  probe: VerifiedToolProbe,
): ProviderProfileRow {
  const profile = getProviderProfile(idOrName);
  if (!profile) throw new Error(`Provider profile not found: ${idOrName}`);
  if (!probe.ok) throw new Error('Tool strategy requires a successful verification probe');
  if (probe.profileId !== profile.id) throw new Error('Tool verification profile mismatch');
  if (probe.fingerprint !== providerToolFingerprint(profile)) {
    throw new Error('Tool verification fingerprint mismatch');
  }
  getDb()
    .prepare(
      `UPDATE provider_profiles
       SET tool_strategy = ?, tool_verified_at = ?, tool_verification_fingerprint = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(strategy, probe.verifiedAt, probe.fingerprint, new Date().toISOString(), profile.id);
  return getProviderProfile(profile.id)!;
}

export function deleteProviderProfile(idOrName: string): void {
  const profile = getProviderProfile(idOrName);
  if (!profile) throw new Error(`Provider profile not found: ${idOrName}`);
  const assigned = getDb()
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM container_configs WHERE provider_profile_id = ?) +
        (SELECT COUNT(*) FROM sessions WHERE provider_profile_id = ?) AS count`,
    )
    .get(profile.id, profile.id) as { count: number };
  if (assigned.count > 0) throw new Error(`Provider profile is assigned and cannot be deleted: ${profile.name}`);
  getDb().prepare('DELETE FROM provider_profiles WHERE id = ?').run(profile.id);
}
