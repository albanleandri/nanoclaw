import { execFileSync } from 'child_process';

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

const verifiers = new Map<string, ProviderVerifier>();

export function registerProviderVerifier(providerName: string, verifier: ProviderVerifier): void {
  if (verifiers.has(providerName)) throw new Error(`Provider verifier already registered: ${providerName}`);
  verifiers.set(providerName, verifier);
}

export function getProviderVerifier(providerName: string): ProviderVerifier | undefined {
  return verifiers.get(providerName);
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
