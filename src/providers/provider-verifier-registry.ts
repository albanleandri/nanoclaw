import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';

import { providerToolFingerprint } from '../db/provider-profiles.js';
import type { ProviderProfileRow } from '../types.js';

export interface ProviderVerifyResult {
  ok: boolean;
  reachable: boolean;
  authenticated: boolean;
  modelAccepted: boolean;
  protocolAccepted: boolean;
  classification?: string;
  hint?: string;
}

export type ProviderVerifier = (
  profile: ProviderProfileRow,
  options: { agentGroupId?: string },
) => Promise<ProviderVerifyResult>;

export interface ProviderToolVerifyResult {
  ok: boolean;
  toolCallingAccepted: boolean;
  fingerprint: string;
  verifiedAt: string;
  classification?: string;
  hint?: string;
}

export type ProviderToolVerifier = (
  profile: ProviderProfileRow,
  options: { agentGroupId?: string },
) => Promise<ProviderToolVerifyResult>;

const verifiers = new Map<string, ProviderVerifier>();
const toolVerifiers = new Map<string, ProviderToolVerifier>();

export function registerProviderVerifier(providerName: string, verifier: ProviderVerifier): void {
  if (verifiers.has(providerName)) throw new Error(`Provider verifier already registered: ${providerName}`);
  verifiers.set(providerName, verifier);
}

export function getProviderVerifier(providerName: string): ProviderVerifier | undefined {
  return verifiers.get(providerName);
}

export function registerProviderToolVerifier(providerName: string, verifier: ProviderToolVerifier): void {
  if (toolVerifiers.has(providerName)) throw new Error(`Provider tool verifier already registered: ${providerName}`);
  toolVerifiers.set(providerName, verifier);
}

export async function verifyProviderTools(
  profile: ProviderProfileRow,
  options: { agentGroupId?: string } = {},
): Promise<ProviderToolVerifyResult> {
  const verifier = toolVerifiers.get(profile.provider_name);
  if (verifier) return verifier(profile, options);
  return {
    ok: false,
    toolCallingAccepted: false,
    fingerprint: '',
    verifiedAt: new Date().toISOString(),
    classification: 'unsupported',
    hint: `No tool verifier is installed for ${profile.provider_name}`,
  };
}

export async function verifyProviderProfile(
  profile: ProviderProfileRow,
  options: { agentGroupId?: string } = {},
): Promise<ProviderVerifyResult> {
  const verifier = getProviderVerifier(profile.provider_name);
  if (!verifier) {
    return {
      ok: false,
      reachable: false,
      authenticated: false,
      modelAccepted: false,
      protocolAccepted: false,
      classification: 'unsupported',
      hint: `No executable verifier is installed for ${profile.provider_name}`,
    };
  }
  return verifier(profile, options);
}

function statusClassification(status: number): Pick<ProviderVerifyResult, 'classification' | 'hint'> {
  if (status === 401 || status === 403) return { classification: 'auth', hint: 'Check the OneCLI secret assignment.' };
  if (status === 404) return { classification: 'protocol', hint: 'Check the base URL and API family.' };
  if (status === 429) return { classification: 'rate_limit', hint: 'The endpoint is reachable but rate-limited.' };
  return { classification: 'request', hint: `Endpoint returned HTTP ${status}.` };
}

registerProviderVerifier('openai-compatible', async (profile, options) => {
  if (!profile.base_url || !profile.api_family || !profile.default_model) {
    return {
      ok: false,
      reachable: false,
      authenticated: false,
      modelAccepted: false,
      protocolAccepted: false,
      classification: 'configuration',
      hint: 'Profile requires base URL, API family, and model.',
    };
  }
  if (profile.auth_mode !== 'none' && !options.agentGroupId) {
    return {
      ok: false,
      reachable: false,
      authenticated: false,
      modelAccepted: false,
      protocolAccepted: false,
      classification: 'configuration',
      hint: 'Authenticated verification requires --agent-group-id so OneCLI uses the same agent policy.',
    };
  }
  const suffix = profile.api_family === 'responses' ? '/responses' : '/chat/completions';
  const url = profile.base_url.endsWith(suffix) ? profile.base_url : `${profile.base_url.replace(/\/+$/, '')}${suffix}`;
  const body =
    profile.api_family === 'responses'
      ? { model: profile.default_model, input: 'Reply with OK.', max_output_tokens: 1 }
      : {
          model: profile.default_model,
          messages: [{ role: 'user', content: 'Reply with OK.' }],
          max_tokens: 1,
        };
  const curlArgs = [
    '--silent',
    '--show-error',
    '--max-time',
    '30',
    '--output',
    '/dev/null',
    '--write-out',
    '%{http_code}',
    '--request',
    'POST',
    '--header',
    'Content-Type: application/json',
    ...(profile.auth_mode === 'none' ? [] : ['--header', 'Authorization: Bearer placeholder']),
    '--data',
    JSON.stringify(body),
    url,
  ];
  try {
    const command =
      profile.auth_mode === 'none'
        ? { file: 'curl', args: curlArgs }
        : {
            file: 'onecli',
            args: ['run', '--agent', options.agentGroupId!, '--', 'curl', ...curlArgs],
          };
    const output = execFileSync(command.file, command.args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 35_000,
    });
    const status = Number(output.trim().slice(-3));
    if (status >= 200 && status < 300) {
      return {
        ok: true,
        reachable: true,
        authenticated: true,
        modelAccepted: true,
        protocolAccepted: true,
      };
    }
    return {
      ok: false,
      reachable: status > 0,
      authenticated: status !== 401 && status !== 403,
      modelAccepted: false,
      protocolAccepted: status !== 404,
      ...statusClassification(status),
    };
    // Verification is a process boundary: command failures are probe results.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    return {
      ok: false,
      reachable: false,
      authenticated: false,
      modelAccepted: false,
      protocolAccepted: false,
      classification: 'transient',
      hint: error instanceof Error ? error.message.replaceAll(/Bearer\s+\S+/gi, 'Bearer [redacted]') : 'Probe failed',
    };
  }
});

export function buildProviderToolProbe(profile: ProviderProfileRow, nonce: string): Record<string, unknown> {
  const fn = {
    name: 'nanoclaw_capability_probe',
    description: 'Return the supplied nonce. This probe has no side effects.',
    parameters: {
      type: 'object',
      properties: { nonce: { type: 'string', enum: [nonce] } },
      required: ['nonce'],
      additionalProperties: false,
    },
    strict: true,
  };
  const prompt = `Call nanoclaw_capability_probe with nonce ${nonce}. Do not answer with text.`;
  return profile.api_family === 'responses'
    ? { model: profile.default_model, input: prompt, tools: [{ type: 'function', ...fn }], tool_choice: 'required' }
    : {
        model: profile.default_model,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'function', function: fn }],
        tool_choice: 'required',
      };
}

export function toolProbeAccepted(profile: ProviderProfileRow, value: unknown, nonce: string): boolean {
  if (!isRecord(value)) return false;
  const call = profile.api_family === 'responses' ? responsesProbeCall(value) : chatProbeCall(value);
  if (!call || call.name !== 'nanoclaw_capability_probe' || typeof call.arguments !== 'string') return false;
  try {
    const args: unknown = JSON.parse(call.arguments);
    return isRecord(args) && args.nonce === nonce;
    // Invalid provider JSON is an expected negative probe result.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responsesProbeCall(data: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(data.output)) return undefined;
  return data.output.find((item): item is Record<string, unknown> => isRecord(item) && item.type === 'function_call');
}

function chatProbeCall(data: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(data.choices) || !isRecord(data.choices[0])) return undefined;
  const message = data.choices[0].message;
  if (!isRecord(message) || !Array.isArray(message.tool_calls) || !isRecord(message.tool_calls[0])) return undefined;
  const fn = message.tool_calls[0].function;
  return isRecord(fn) ? fn : undefined;
}

registerProviderToolVerifier('openai-compatible', async (profile, options) => {
  const verifiedAt = new Date().toISOString();
  const fingerprint = providerToolFingerprint(profile);
  if (!profile.base_url || !profile.api_family || !profile.default_model) {
    return {
      ok: false,
      toolCallingAccepted: false,
      fingerprint,
      verifiedAt,
      classification: 'configuration',
      hint: 'Profile requires base URL, API family, and model.',
    };
  }
  if (profile.auth_mode !== 'none' && !options.agentGroupId) {
    return {
      ok: false,
      toolCallingAccepted: false,
      fingerprint,
      verifiedAt,
      classification: 'configuration',
      hint: 'Authenticated tool verification requires --agent-group-id.',
    };
  }
  const nonce = randomUUID();
  const suffix = profile.api_family === 'responses' ? '/responses' : '/chat/completions';
  const url = profile.base_url.endsWith(suffix) ? profile.base_url : `${profile.base_url.replace(/\/+$/, '')}${suffix}`;
  const curlArgs = [
    '--silent',
    '--show-error',
    '--fail-with-body',
    '--max-time',
    '30',
    '--request',
    'POST',
    '--header',
    'Content-Type: application/json',
    ...(profile.auth_mode === 'none' ? [] : ['--header', 'Authorization: Bearer placeholder']),
    '--data',
    JSON.stringify(buildProviderToolProbe(profile, nonce)),
    url,
  ];
  try {
    const command =
      profile.auth_mode === 'none'
        ? { file: 'curl', args: curlArgs }
        : { file: 'onecli', args: ['run', '--agent', options.agentGroupId!, '--', 'curl', ...curlArgs] };
    const output = execFileSync(command.file, command.args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 35_000,
    });
    const accepted = toolProbeAccepted(profile, JSON.parse(output), nonce);
    return {
      ok: accepted,
      toolCallingAccepted: accepted,
      fingerprint,
      verifiedAt,
      ...(accepted ? {} : { classification: 'tool_unsupported', hint: 'Endpoint did not return the probe call.' }),
    };
    // Verification is a process boundary: command/parse failures are probe results.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    return {
      ok: false,
      toolCallingAccepted: false,
      fingerprint,
      verifiedAt,
      classification: 'transient',
      hint: error instanceof Error ? error.message.replaceAll(/Bearer\s+\S+/gi, 'Bearer [redacted]') : 'Probe failed',
    };
  }
});
