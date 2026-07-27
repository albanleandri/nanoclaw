import { createAuxiliaryInvocation, completeAuxiliaryInvocation } from '../db/auxiliary-invocations.js';
import { updateJobStatus } from '../db/jobs.js';
import type { EffectiveRuntimeSelection } from '../providers/runtime-descriptor.js';
import type { Session } from '../types.js';
import { resolveAuxiliaryRoute, type AuxiliaryResolution } from './resolve-route.js';
import {
  validateAuxiliaryRequest,
  type AuxiliaryInvocationInput,
  type AuxiliaryRequest,
  type AuxiliaryResult,
} from './types.js';

export type AuxiliaryExecutor = (
  request: AuxiliaryRequest,
  resolution: AuxiliaryResolution,
  signal: AbortSignal,
) => Promise<Omit<AuxiliaryResult, 'invocationId'>>;

/**
 * Durable auxiliary-invocation executor.
 *
 * STATUS: staged scaffolding — no production caller dispatches through this
 * yet. The `ncl auxiliary-routes` config surface (migration 023,
 * src/db/auxiliary-routes) is live. See docs/db-central.md §1.20.
 *
 * TRUST BOUNDARY: source identity is stamped from the `session` the host
 * already trusts, never taken from the caller — `AuxiliaryInvocationInput` has
 * no source field to spoof. The target likewise comes only from the
 * operator-configured route for that session's group and role; there is no
 * caller-supplied target override. Both properties are structural, so wiring
 * this to a container-facing delivery action or MCP tool cannot reintroduce
 * group impersonation or route override by forgetting a check at the call site.
 */
export async function executeAuxiliaryInvocation(input: {
  invocation: AuxiliaryInvocationInput;
  session: Pick<Session, 'id' | 'agent_group_id'>;
  currentRuntime: EffectiveRuntimeSelection;
  executor: AuxiliaryExecutor;
}): Promise<AuxiliaryResult> {
  const request = validateAuxiliaryRequest({
    ...input.invocation,
    sourceAgentGroupId: input.session.agent_group_id,
    sourceSessionId: input.session.id,
  });
  const resolution = resolveAuxiliaryRoute({ request, currentRuntime: input.currentRuntime });
  const persisted = createAuxiliaryInvocation(request, resolution.target);
  if (
    persisted.job.status === 'succeeded' ||
    persisted.job.status === 'failed' ||
    persisted.job.status === 'cancelled'
  ) {
    return persisted.job.result!;
  }
  updateJobStatus(request.invocationId, { status: 'running', startedAt: new Date().toISOString() });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Auxiliary invocation timed out')), request.timeoutMs);
  let result: AuxiliaryResult;
  try {
    const executed = await input.executor(request, resolution, controller.signal);
    result = {
      ...executed,
      invocationId: request.invocationId,
      runtimeId: executed.runtimeId ?? resolution.runtime.runtimeId,
      providerProfileId: executed.providerProfileId ?? resolution.runtime.endpointProfileId,
      model: executed.model ?? resolution.runtime.model,
    };
  } catch (error) {
    // The durable service boundary classifies executor failures into its result contract.
    result = {
      invocationId: request.invocationId,
      status: controller.signal.aborted ? 'cancelled' : 'failed',
      runtimeId: resolution.runtime.runtimeId,
      providerProfileId: resolution.runtime.endpointProfileId,
      model: resolution.runtime.model,
      error: {
        classification: controller.signal.aborted ? 'timeout' : 'execution',
        retryable: false,
        message: error instanceof Error ? error.message : 'Auxiliary invocation failed',
      },
    };
  } finally {
    clearTimeout(timeout);
  }
  return completeAuxiliaryInvocation(result).job.result!;
}
