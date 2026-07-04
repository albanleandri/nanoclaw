import { createAuxiliaryInvocation, completeAuxiliaryInvocation } from '../db/auxiliary-invocations.js';
import { updateJobStatus } from '../db/jobs.js';
import type { EffectiveRuntimeSelection } from '../providers/runtime-descriptor.js';
import { resolveAuxiliaryRoute, type AuxiliaryResolution } from './resolve-route.js';
import {
  validateAuxiliaryRequest,
  type AuxiliaryRequest,
  type AuxiliaryResult,
  type AuxiliaryTarget,
} from './types.js';

export type AuxiliaryExecutor = (
  request: AuxiliaryRequest,
  resolution: AuxiliaryResolution,
  signal: AbortSignal,
) => Promise<Omit<AuxiliaryResult, 'invocationId'>>;

/**
 * Durable auxiliary-invocation executor.
 *
 * STATUS: staged scaffolding — NOT yet wired to any production caller. The
 * `ncl auxiliary-routes` config surface (migration 023, src/db/auxiliary-routes)
 * is live, but nothing dispatches an invocation through this function outside
 * tests. See docs/db-central.md §1.19.
 *
 * ⚠ SECURITY PRECONDITION before exposing this to a container-facing delivery
 * action or MCP tool: `request.sourceAgentGroupId` / `sourceSessionId` and the
 * `target` override are trusted verbatim here (validateAuxiliaryRequest only
 * checks they are non-empty). A container could otherwise impersonate another
 * group or override its configured route. Stamp source from the trusted session
 * and drop the caller-supplied `target` at the wiring boundary first.
 */
export async function executeAuxiliaryInvocation(input: {
  request: AuxiliaryRequest;
  currentRuntime: EffectiveRuntimeSelection;
  target?: AuxiliaryTarget;
  executor: AuxiliaryExecutor;
}): Promise<AuxiliaryResult> {
  const request = validateAuxiliaryRequest(input.request);
  const resolution = resolveAuxiliaryRoute({
    request,
    currentRuntime: input.currentRuntime,
    target: input.target,
  });
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
