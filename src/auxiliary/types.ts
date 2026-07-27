export const AUXILIARY_ROLES = [
  'context-compression',
  'memory-extraction',
  'vision',
  'classification',
  'review',
  'reference-analysis',
] as const;

export type AuxiliaryRole = (typeof AUXILIARY_ROLES)[number];

export type AuxiliaryTarget =
  | { kind: 'main' }
  | { kind: 'endpoint-profile'; providerProfileId: string; model?: string }
  | { kind: 'agent'; agentGroupId: string }
  | { kind: 'disabled' };

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  estimatedCostUsd?: number;
  source: 'provider' | 'estimated' | 'unknown';
}

/**
 * What a caller may ask for. Deliberately carries NO source identity and NO
 * target: `sourceAgentGroupId`/`sourceSessionId` are stamped from the trusted
 * session and the target is read from the operator-configured route, so a
 * container-facing caller has no field with which to impersonate another group
 * or override its route. See executeAuxiliaryInvocation.
 */
export interface AuxiliaryInvocationInput {
  invocationId: string;
  role: AuxiliaryRole;
  objective: string;
  context: string;
  maxOutputTokens?: number;
  timeoutMs: number;
}

/** Internal stamped request. Only the service constructs this. */
export interface AuxiliaryRequest extends AuxiliaryInvocationInput {
  sourceAgentGroupId: string;
  sourceSessionId: string;
}

export interface AuxiliaryResult {
  invocationId: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  output?: string;
  usage?: ModelUsage;
  runtimeId?: string;
  providerProfileId?: string;
  model?: string;
  error?: { classification: string; retryable: boolean; message: string };
}

export function validateAuxiliaryRequest(input: AuxiliaryRequest): AuxiliaryRequest {
  if (!input.invocationId.trim() || input.invocationId.length > 200) throw new Error('Invalid auxiliary invocation ID');
  if (!(AUXILIARY_ROLES as readonly string[]).includes(input.role)) throw new Error('Unknown auxiliary role');
  if (!input.objective.trim() || input.objective.length > 8_000) throw new Error('Invalid auxiliary objective');
  if (input.context.length > 128_000) throw new Error('Auxiliary context exceeds 128000 characters');
  if (!input.sourceAgentGroupId.trim() || !input.sourceSessionId.trim())
    throw new Error('Auxiliary source is required');
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 600_000) {
    throw new Error('Auxiliary timeout must be between 1000 and 600000 ms');
  }
  if (
    input.maxOutputTokens !== undefined &&
    (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > 100_000)
  ) {
    throw new Error('Invalid auxiliary output token limit');
  }
  return { ...input, objective: input.objective.trim() };
}
