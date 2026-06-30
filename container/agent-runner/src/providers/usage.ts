import type { ProviderUsage } from './types.js';

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function normalizeProviderUsage(value: unknown): ProviderUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const inputTokens = finiteNonNegative(row.input_tokens ?? row.inputTokens ?? row.prompt_tokens);
  const outputTokens = finiteNonNegative(row.output_tokens ?? row.outputTokens ?? row.completion_tokens);
  const details =
    row.prompt_tokens_details && typeof row.prompt_tokens_details === 'object'
      ? (row.prompt_tokens_details as Record<string, unknown>)
      : undefined;
  const cachedTokens = finiteNonNegative(
    row.cached_tokens ??
      row.cachedTokens ??
      row.cache_read_input_tokens ??
      row.cache_creation_input_tokens ??
      details?.cached_tokens,
  );
  if (inputTokens === undefined && outputTokens === undefined && cachedTokens === undefined) return undefined;
  return { inputTokens, outputTokens, cachedTokens, source: 'provider' };
}
