/* eslint-disable no-catch-all/no-catch-all -- this boundary must not reflect adapter, credential, or upstream errors */
import {
  finishIntegrationInvocation,
  startIntegrationInvocation,
  type IntegrationInvocationFailureClass,
} from '../db/integration-invocations.js';
import {
  getIntegrationProfileRow,
  hasIntegrationProfileGrant,
  requireIntegrationProfile,
  type IntegrationProfile,
} from '../db/integration-profiles.js';
import type { CallerContext } from '../cli/frame.js';
import type { IntegrationCredentialBackend } from '../types.js';
import { CredentialStoreError, type HostCredentialStore } from './credential-store.js';
import { LocalFileCredentialStore } from './local-file-credential-store.js';
import { validateAndClassifyProtectedPayload } from './protected-payload.js';
import {
  requireHostIntegrationAdapter,
  requireHostIntegrationOperation,
  type HostIntegrationRegistry,
} from './registry.js';
import type { HostIntegrationOperation } from './types.js';

const DEFAULT_MAX_QUEUED_PER_PROFILE = 32;

export type HostIntegrationInvocationStage =
  'authorization' | 'profile' | 'input' | 'queue' | 'credential' | 'audit' | 'execution' | 'output';

const SAFE_MESSAGES: Record<IntegrationInvocationFailureClass, string> = {
  not_authorized: 'Integration is not available.',
  disabled: 'Integration is disabled.',
  credential_unavailable: 'Integration credential is unavailable.',
  credential_unsafe: 'Integration credential storage is unsafe.',
  authentication_rejected: 'Integration authentication was rejected.',
  upstream_timeout: 'Integration request timed out.',
  upstream_transient: 'Integration service is temporarily unavailable.',
  upstream_contract_changed: 'Integration response was invalid.',
  invalid_configuration: 'Integration configuration is invalid.',
  busy: 'Integration is busy.',
  internal: 'Integration request failed.',
};

const ADAPTER_FAILURE_CLASSES = new Set<IntegrationInvocationFailureClass>([
  'authentication_rejected',
  'upstream_timeout',
  'upstream_transient',
  'upstream_contract_changed',
  'invalid_configuration',
  'internal',
]);

/** Stable, non-reflecting error returned by the host integration boundary. */
export class HostIntegrationInvocationError extends Error {
  constructor(
    readonly resultClass: IntegrationInvocationFailureClass,
    readonly stage: HostIntegrationInvocationStage,
  ) {
    super(SAFE_MESSAGES[resultClass]);
    this.name = 'HostIntegrationInvocationError';
  }
}

/**
 * Error an adapter may throw to classify a known safe upstream failure.
 * Free-form adapter messages are deliberately not accepted or propagated.
 */
export class HostIntegrationOperationError extends Error {
  constructor(readonly resultClass: IntegrationInvocationFailureClass) {
    if (!ADAPTER_FAILURE_CLASSES.has(resultClass)) {
      throw new Error('Invalid host integration operation failure class');
    }
    super(SAFE_MESSAGES[resultClass]);
    this.name = 'HostIntegrationOperationError';
  }
}

export interface HostIntegrationInvocationResult {
  observed_at: string;
  profile: {
    id: string;
    name: string;
  };
  adapter: {
    id: string;
    version: number;
  };
  operation: string;
  data: unknown;
}

export interface InvokeHostIntegrationInput {
  caller: CallerContext;
  profile: string;
  operation: string;
  input: unknown;
  signal?: AbortSignal;
}

type RegistryReader = Pick<HostIntegrationRegistry, 'require' | 'requireOperation'>;
export type CredentialStoreResolver = (backend: IntegrationCredentialBackend) => HostCredentialStore | undefined;

interface QueueWaiter {
  resolve: (lease: ProfileInvocationLease) => void;
  reject: (error: HostIntegrationInvocationError) => void;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
}

interface ProfileGateState {
  active: boolean;
  waiters: QueueWaiter[];
}

export interface ProfileInvocationLease {
  release(): void;
}

/** Process-local one-at-a-time gate. NanoClaw has a single host process. */
export class ProfileInvocationGate {
  private readonly states = new Map<string, ProfileGateState>();

  constructor(private readonly maxQueuedPerProfile = DEFAULT_MAX_QUEUED_PER_PROFILE) {
    if (!Number.isInteger(maxQueuedPerProfile) || maxQueuedPerProfile < 0 || maxQueuedPerProfile > 1_000) {
      throw new Error('Host integration queue limit is invalid');
    }
  }

  acquire(profileId: string, deadlineAt: number, signal?: AbortSignal): Promise<ProfileInvocationLease> {
    if (signal?.aborted) return Promise.reject(failure('internal', 'queue'));
    if (deadlineAt <= Date.now()) return Promise.reject(failure('busy', 'queue'));

    const state = this.states.get(profileId) ?? { active: false, waiters: [] };
    this.states.set(profileId, state);
    if (!state.active) {
      state.active = true;
      return Promise.resolve(this.lease(profileId));
    }
    if (state.waiters.length >= this.maxQueuedPerProfile) {
      return Promise.reject(failure('busy', 'queue'));
    }

    return new Promise<ProfileInvocationLease>((resolve, reject) => {
      const waiter: QueueWaiter = {
        resolve,
        reject,
        signal,
        settled: false,
      };
      const rejectWaiter = (resultClass: IntegrationInvocationFailureClass): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        this.removeWaiter(profileId, waiter);
        this.clearWaiter(waiter);
        reject(failure(resultClass, 'queue'));
      };
      waiter.timer = setTimeout(() => rejectWaiter('busy'), Math.max(1, deadlineAt - Date.now()));
      if (signal) {
        waiter.onAbort = () => rejectWaiter('internal');
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      state.waiters.push(waiter);
    });
  }

  private lease(profileId: string): ProfileInvocationLease {
    let released = false;
    return Object.freeze({
      release: () => {
        if (released) return;
        released = true;
        this.release(profileId);
      },
    });
  }

  private release(profileId: string): void {
    const state = this.states.get(profileId);
    if (!state) return;
    while (state.waiters.length > 0) {
      const waiter = state.waiters.shift()!;
      if (waiter.settled) continue;
      waiter.settled = true;
      this.clearWaiter(waiter);
      waiter.resolve(this.lease(profileId));
      return;
    }
    state.active = false;
    this.states.delete(profileId);
  }

  private removeWaiter(profileId: string, waiter: QueueWaiter): void {
    const state = this.states.get(profileId);
    if (!state) return;
    const index = state.waiters.indexOf(waiter);
    if (index >= 0) state.waiters.splice(index, 1);
  }

  private clearWaiter(waiter: QueueWaiter): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
  }
}

const defaultRegistry: RegistryReader = {
  require: requireHostIntegrationAdapter,
  requireOperation: requireHostIntegrationOperation,
};
const localFileStore = new LocalFileCredentialStore();
const defaultGate = new ProfileInvocationGate();

function defaultStoreResolver(backend: IntegrationCredentialBackend): HostCredentialStore | undefined {
  return backend === 'local-file' ? localFileStore : undefined;
}

export class HostIntegrationInvoker {
  constructor(
    private readonly registry: RegistryReader = defaultRegistry,
    private readonly resolveStore: CredentialStoreResolver = defaultStoreResolver,
    private readonly gate: ProfileInvocationGate = defaultGate,
  ) {}

  async invoke(request: InvokeHostIntegrationInput): Promise<HostIntegrationInvocationResult> {
    const row = getIntegrationProfileRow(request.profile);

    // This grant check intentionally precedes every distinguishable profile,
    // adapter, credential, and operation error for agent callers.
    if (request.caller.caller === 'agent') {
      // Perform the same indexed grant lookup for a missing selection so the
      // nonexistent and ungranted paths have the same externally observable
      // query shape as well as the same result class and message.
      const granted = hasIntegrationProfileGrant(
        row?.id ?? request.profile,
        request.caller.agentGroupId,
        request.operation,
      );
      if (!row || !granted) throw failure('not_authorized', 'authorization');
    }
    if (!row) throw failure('not_authorized', 'authorization');
    if (row.enabled !== 1) throw failure('disabled', 'profile');

    let profile: IntegrationProfile;
    let operation: HostIntegrationOperation<object, object>;
    try {
      profile = requireIntegrationProfile(row.id, this.registry);
      operation = this.registry.requireOperation(row.adapter_id, row.adapter_version, request.operation);
    } catch {
      throw failure('invalid_configuration', 'profile');
    }

    const deadlineAt = Date.now() + operation.totalDeadlineMs;
    let validatedInput: unknown;
    try {
      validatedInput = operation.validateInput(request.input);
    } catch {
      throw failure('invalid_configuration', 'input');
    }

    const lease = await this.gate.acquire(profile.id, deadlineAt, request.signal);
    let auditId: string | undefined;
    let auditFinished = false;
    try {
      const protectedPayload = await this.readProtectedPayload(profile, deadlineAt, request.signal);
      if (Date.now() >= deadlineAt) throw failure('upstream_timeout', 'credential');

      try {
        const audit = startIntegrationInvocation(
          {
            profileId: profile.id,
            operation: request.operation,
            callerType: request.caller.caller,
            agentGroupId: request.caller.caller === 'agent' ? request.caller.agentGroupId : null,
            sessionId: request.caller.caller === 'agent' ? request.caller.sessionId : null,
          },
          this.registry,
        );
        auditId = audit.id;
      } catch {
        throw failure('internal', 'audit');
      }

      try {
        const rawOutput = await executeWithinDeadline(
          operation,
          {
            config: profile.config,
            protectedPayload,
            input: validatedInput,
          },
          deadlineAt,
          request.signal,
        );
        const data = validateAndFreezeOutput(operation, rawOutput);
        finishIntegrationInvocation(auditId, { status: 'succeeded', resultClass: 'success' });
        auditFinished = true;
        return {
          observed_at: new Date().toISOString(),
          profile: { id: profile.id, name: profile.name },
          adapter: { id: profile.adapter_id, version: profile.adapter_version },
          operation: request.operation,
          data,
        };
      } catch (error) {
        const safeError = classifyExecutionError(error);
        try {
          finishIntegrationInvocation(auditId, {
            status: 'failed',
            resultClass: safeError.resultClass,
          });
          auditFinished = true;
        } catch {
          throw failure('internal', 'audit');
        }
        throw safeError;
      }
    } finally {
      if (auditId && !auditFinished) {
        try {
          finishIntegrationInvocation(auditId, { status: 'failed', resultClass: 'internal' });
        } catch {
          // Startup reconciliation is the final fallback if the audit store
          // itself is unavailable while terminal completion is attempted.
        }
      }
      lease.release();
    }
  }

  private async readProtectedPayload(
    profile: IntegrationProfile,
    deadlineAt: number,
    callerSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const store = this.resolveStore(profile.credential_backend);
    if (!store) throw failure('credential_unavailable', 'credential');

    let status: Awaited<ReturnType<HostCredentialStore['status']>>;
    try {
      status = await awaitWithinDeadline(store.status(profile.credential_ref), deadlineAt, callerSignal);
    } catch (error) {
      throw classifyCredentialError(error);
    }
    if (status === 'missing') throw failure('credential_unavailable', 'credential');
    if (status === 'unsafe') throw failure('credential_unsafe', 'credential');

    let stored: unknown;
    try {
      stored = await awaitWithinDeadline(store.read(profile.credential_ref), deadlineAt, callerSignal);
    } catch (error) {
      throw classifyCredentialError(error);
    }
    try {
      const adapter = this.registry.require(profile.adapter_id, profile.adapter_version);
      return validateAndClassifyProtectedPayload(adapter, stored);
    } catch {
      throw failure('credential_unsafe', 'credential');
    }
  }
}

interface ExecutionContext {
  config: object;
  protectedPayload: object;
  input: unknown;
}

class InvocationAbort extends Error {
  constructor(readonly kind: 'deadline' | 'caller') {
    super('Host integration invocation aborted');
  }
}

async function awaitWithinDeadline<T>(promise: Promise<T>, deadlineAt: number, callerSignal?: AbortSignal): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new InvocationAbort('deadline');
  if (callerSignal?.aborted) throw new InvocationAbort('caller');

  let rejectAbort: ((error: InvocationAbort) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  let settled = false;
  const rejectOnce = (kind: 'deadline' | 'caller'): void => {
    if (settled) return;
    settled = true;
    rejectAbort?.(new InvocationAbort(kind));
  };
  const onCallerAbort = () => rejectOnce('caller');
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => rejectOnce('deadline'), remaining);
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    settled = true;
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

async function executeWithinDeadline(
  operation: HostIntegrationOperation<object, object>,
  context: ExecutionContext,
  deadlineAt: number,
  callerSignal?: AbortSignal,
): Promise<unknown> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new InvocationAbort('deadline');
  if (callerSignal?.aborted) throw new InvocationAbort('caller');

  const controller = new AbortController();
  let rejectAbort: ((error: InvocationAbort) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (kind: 'deadline' | 'caller'): void => {
    if (controller.signal.aborted) return;
    controller.abort();
    rejectAbort?.(new InvocationAbort(kind));
  };
  const onCallerAbort = () => abort('caller');
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => abort('deadline'), remaining);

  try {
    const execution = Promise.resolve().then(() =>
      operation.execute({
        config: context.config,
        protectedPayload: context.protectedPayload,
        input: context.input,
        signal: controller.signal,
      }),
    );
    return await Promise.race([execution, abortPromise]);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

function validateAndFreezeOutput(operation: HostIntegrationOperation<object, object>, rawOutput: unknown): unknown {
  let projected: unknown;
  try {
    projected = operation.validateOutput(rawOutput);
  } catch {
    throw failure('upstream_contract_changed', 'output');
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(projected);
  } catch {
    throw failure('upstream_contract_changed', 'output');
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, 'utf8') > operation.responseLimits.maxNormalizedOutputBytes
  ) {
    throw failure('upstream_contract_changed', 'output');
  }
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw failure('upstream_contract_changed', 'output');
  }
}

function classifyExecutionError(error: unknown): HostIntegrationInvocationError {
  if (error instanceof HostIntegrationInvocationError) return error;
  if (error instanceof HostIntegrationOperationError) {
    return failure(error.resultClass, 'execution');
  }
  if (error instanceof InvocationAbort) {
    return failure(error.kind === 'deadline' ? 'upstream_timeout' : 'internal', 'execution');
  }
  return failure('internal', 'execution');
}

function classifyCredentialError(error: unknown): HostIntegrationInvocationError {
  if (error instanceof InvocationAbort) {
    return failure(error.kind === 'deadline' ? 'upstream_timeout' : 'internal', 'credential');
  }
  if (
    error instanceof CredentialStoreError &&
    (error.code === 'unsafe' || error.code === 'invalid_payload' || error.code === 'invalid_reference')
  ) {
    return failure('credential_unsafe', 'credential');
  }
  return failure('credential_unavailable', 'credential');
}

function failure(
  resultClass: IntegrationInvocationFailureClass,
  stage: HostIntegrationInvocationStage,
): HostIntegrationInvocationError {
  return new HostIntegrationInvocationError(resultClass, stage);
}

export const hostIntegrationInvoker = new HostIntegrationInvoker();
/* eslint-enable no-catch-all/no-catch-all */
