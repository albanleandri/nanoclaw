import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup } from '../db/agent-groups.js';
import { closeDb, initTestDb } from '../db/connection.js';
import { listIntegrationInvocations } from '../db/integration-invocations.js';
import {
  createIntegrationProfile,
  grantIntegrationProfileOperation,
  setIntegrationProfileEnabled,
} from '../db/integration-profiles.js';
import { runMigrations } from '../db/migrations/index.js';
import { createSession } from '../db/sessions.js';
import type { CallerContext } from '../cli/frame.js';
import { CredentialStoreError } from './credential-store.js';
import type { CredentialRef, CredentialStatus, HostCredentialStore, StagedCredential } from './credential-store.js';
import {
  HostIntegrationInvocationError,
  HostIntegrationInvoker,
  HostIntegrationOperationError,
  ProfileInvocationGate,
} from './invoker.js';
import { createHostIntegrationRegistry, type HostIntegrationRegistry } from './registry.js';
import type { HostIntegrationAdapter, HostIntegrationOperationContext } from './types.js';

const agentA: CallerContext = {
  caller: 'agent',
  agentGroupId: 'agent-a',
  sessionId: 'session-a',
  messagingGroupId: 'messaging-a',
};
const agentB: CallerContext = {
  caller: 'agent',
  agentGroupId: 'agent-b',
  sessionId: 'session-b',
  messagingGroupId: 'messaging-b',
};

class MemoryCredentialStore implements HostCredentialStore {
  statusValue: CredentialStatus = 'available';
  payload: unknown = { password: 'SENTINEL_CREDENTIAL' };
  statusCalls = 0;
  readCalls = 0;

  async status(_ref: CredentialRef): Promise<CredentialStatus> {
    this.statusCalls += 1;
    return this.statusValue;
  }

  async read(_ref: CredentialRef): Promise<unknown> {
    this.readCalls += 1;
    return this.payload;
  }

  async stage(_ref: CredentialRef, _value: unknown): Promise<StagedCredential> {
    throw new Error('not implemented');
  }

  async promote(_staged: StagedCredential): Promise<void> {
    throw new Error('not implemented');
  }

  async discard(_staged: StagedCredential): Promise<void> {
    throw new Error('not implemented');
  }

  async revoke(_ref: CredentialRef): Promise<void> {
    throw new Error('not implemented');
  }
}

interface Behavior {
  validateInput(value: unknown): unknown;
  validateOutput(value: unknown): unknown;
  execute(context: HostIntegrationOperationContext<{ tenant: string }, { password: string }>): Promise<unknown>;
}

interface Harness {
  registry: HostIntegrationRegistry;
  store: MemoryCredentialStore;
  behavior: Behavior;
  profileId: string;
  invoker: HostIntegrationInvoker;
}

function createHarness(
  options: {
    enabled?: boolean;
    grantAgentA?: boolean;
    deadlineMs?: number;
    maxOutputBytes?: number;
    maxQueued?: number;
  } = {},
): Harness {
  const behavior: Behavior = {
    validateInput: (value) => value,
    validateOutput: (value) => value,
    execute: async () => ({ items: [] }),
  };
  const registry = createHostIntegrationRegistry();
  const adapter: HostIntegrationAdapter<{ tenant: string }, { password: string }> = {
    id: 'invoker-test',
    version: 1,
    securityTier: 'trusted-host',
    hostAuthJustification: 'Test-only host credential boundary.',
    validateConfig(value) {
      if (
        !value ||
        typeof value !== 'object' ||
        Object.keys(value).join(',') !== 'tenant' ||
        typeof (value as { tenant?: unknown }).tenant !== 'string'
      ) {
        throw new Error('invalid config');
      }
      return { tenant: (value as { tenant: string }).tenant };
    },
    validateProtectedPayload(value) {
      if (
        !value ||
        typeof value !== 'object' ||
        Object.keys(value).join(',') !== 'password' ||
        typeof (value as { password?: unknown }).password !== 'string'
      ) {
        throw new Error(`invalid protected payload ${(value as { password?: unknown })?.password}`);
      }
      return { password: (value as { password: string }).password };
    },
    protectedFields: [{ name: 'password', sensitivity: 'secret', label: 'Password' }],
    operations: {
      read: {
        name: 'read',
        sideEffects: 'none',
        validateInput: (value) => behavior.validateInput(value),
        validateOutput: (value) => behavior.validateOutput(value),
        totalDeadlineMs: options.deadlineMs ?? 1_000,
        network: {
          maxRedirects: 0,
          destinations: [
            {
              origin: 'https://invoker.example.test',
              methods: ['GET'],
              isAllowedUrl: (url) => url.origin === 'https://invoker.example.test',
            },
          ],
        },
        responseLimits: {
          maxHeaderBytes: 1_024,
          maxCookieBytes: 1_024,
          maxBodyBytes: 1_024,
          maxNormalizedOutputBytes: options.maxOutputBytes ?? 1_024,
        },
        execute: (context) => behavior.execute(context),
      },
    },
  };
  registry.register(adapter);
  const profile = createIntegrationProfile(
    {
      id: 'profile-1',
      name: 'Private profile',
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      config: { tenant: 'safe-tenant' },
      credentialBackend: 'local-file',
    },
    registry,
  );
  if (options.enabled !== false) {
    setIntegrationProfileEnabled(profile.id, profile.version, true, registry);
  }
  if (options.grantAgentA !== false) {
    grantIntegrationProfileOperation(profile.id, 'agent-a', 'read', registry);
  }
  const store = new MemoryCredentialStore();
  const gate =
    options.maxQueued === undefined ? new ProfileInvocationGate() : new ProfileInvocationGate(options.maxQueued);
  return {
    registry,
    store,
    behavior,
    profileId: profile.id,
    invoker: new HostIntegrationInvoker(registry, () => store, gate),
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  for (const id of ['agent-a', 'agent-b']) {
    createAgentGroup({
      id,
      name: id,
      folder: id,
      agent_provider: null,
      created_at: '2026-10-03T08:00:00Z',
    });
    createSession({
      id: `session-${id.at(-1)}`,
      agent_group_id: id,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-10-03T08:00:00Z',
    });
  }
});

afterEach(closeDb);

describe('HostIntegrationInvoker authorization and preflight', () => {
  it('makes nonexistent and ungranted profiles indistinguishable before adapter, credential, network, or audit access', async () => {
    const harness = createHarness();
    const requireSpy = vi.spyOn(harness.registry, 'require');
    const executeSpy = vi.spyOn(harness.behavior, 'execute');

    const existing = harness.invoker.invoke({
      caller: agentB,
      profile: harness.profileId,
      operation: 'read',
      input: {},
    });
    const missing = harness.invoker.invoke({
      caller: agentB,
      profile: 'missing-profile',
      operation: 'read',
      input: {},
    });

    await expect(existing).rejects.toMatchObject({
      resultClass: 'not_authorized',
      message: 'Integration is not available.',
    });
    await expect(missing).rejects.toMatchObject({
      resultClass: 'not_authorized',
      message: 'Integration is not available.',
    });
    expect(requireSpy).not.toHaveBeenCalled();
    expect(harness.store.statusCalls).toBe(0);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(listIntegrationInvocations()).toEqual([]);
  });

  it('reports a disabled authorized profile before credential access', async () => {
    const harness = createHarness({ enabled: false });

    await expect(
      harness.invoker.invoke({ caller: agentA, profile: harness.profileId, operation: 'read', input: {} }),
    ).rejects.toMatchObject({ resultClass: 'disabled', stage: 'profile' });
    expect(harness.store.statusCalls).toBe(0);
    expect(listIntegrationInvocations()).toEqual([]);
  });

  it('validates input before credential access without reflecting validator errors', async () => {
    const harness = createHarness();
    harness.behavior.validateInput = () => {
      throw new Error('SENTINEL_INPUT_ERROR');
    };

    const promise = harness.invoker.invoke({
      caller: agentA,
      profile: harness.profileId,
      operation: 'read',
      input: { unsafe: 'SENTINEL_INPUT' },
    });
    await expect(promise).rejects.toMatchObject({
      resultClass: 'invalid_configuration',
      message: 'Integration configuration is invalid.',
    });
    await expect(promise).rejects.not.toThrow(/SENTINEL/);
    expect(harness.store.statusCalls).toBe(0);
    expect(listIntegrationInvocations()).toEqual([]);
  });

  it.each([
    ['missing', 'credential_unavailable'],
    ['unsafe', 'credential_unsafe'],
  ] as const)('maps %s credential state safely before audit creation', async (status, resultClass) => {
    const harness = createHarness();
    harness.store.statusValue = status;

    await expect(
      harness.invoker.invoke({ caller: agentA, profile: harness.profileId, operation: 'read', input: {} }),
    ).rejects.toMatchObject({ resultClass, stage: 'credential' });
    expect(harness.store.readCalls).toBe(0);
    expect(listIntegrationInvocations()).toEqual([]);
  });

  it('classifies an invalid stored protected payload without reflecting it', async () => {
    const harness = createHarness();
    harness.store.payload = { password: 123, extra: 'SENTINEL_STORED_VALUE' };

    const promise = harness.invoker.invoke({
      caller: agentA,
      profile: harness.profileId,
      operation: 'read',
      input: {},
    });
    await expect(promise).rejects.toMatchObject({ resultClass: 'credential_unsafe' });
    await expect(promise).rejects.not.toThrow(/SENTINEL/);
    expect(listIntegrationInvocations()).toEqual([]);
  });

  it('maps a malformed credential-store read to unsafe without reflecting the store error', async () => {
    const harness = createHarness();
    vi.spyOn(harness.store, 'read').mockRejectedValue(
      new CredentialStoreError('invalid_payload', 'SENTINEL_MALFORMED_CREDENTIAL'),
    );

    const promise = harness.invoker.invoke({
      caller: agentA,
      profile: harness.profileId,
      operation: 'read',
      input: {},
    });
    await expect(promise).rejects.toMatchObject({ resultClass: 'credential_unsafe', stage: 'credential' });
    await expect(promise).rejects.not.toThrow(/SENTINEL/);
    expect(listIntegrationInvocations()).toEqual([]);
  });
});

describe('HostIntegrationInvoker execution and audit', () => {
  it('lets a host bypass grants while returning only validated output and a safe success envelope', async () => {
    const harness = createHarness({ grantAgentA: false });
    harness.behavior.validateInput = (value) => ({ query: String((value as { query: unknown }).query).trim() });
    harness.behavior.execute = async ({ config, protectedPayload, input }) => {
      expect(config).toEqual({ tenant: 'safe-tenant' });
      expect(protectedPayload).toEqual({ password: 'SENTINEL_CREDENTIAL' });
      expect(input).toEqual({ query: 'hello' });
      return { items: ['safe'], mutation_url: 'https://danger.test/SENTINEL_ACTION' };
    };
    harness.behavior.validateOutput = (value) => ({ items: (value as { items: unknown }).items });

    const result = await harness.invoker.invoke({
      caller: { caller: 'host' },
      profile: harness.profileId,
      operation: 'read',
      input: { query: ' hello ' },
    });

    expect(result).toMatchObject({
      profile: { id: harness.profileId, name: 'Private profile' },
      adapter: { id: 'invoker-test', version: 1 },
      operation: 'read',
      data: { items: ['safe'] },
    });
    expect(result.observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(result)).not.toContain('SENTINEL_ACTION');
    expect(listIntegrationInvocations()).toEqual([
      expect.objectContaining({
        profile_id: harness.profileId,
        caller_type: 'host',
        agent_group_id: null,
        status: 'succeeded',
        result_class: 'success',
      }),
    ]);
    expect(JSON.stringify(listIntegrationInvocations())).not.toContain('SENTINEL_CREDENTIAL');
  });

  it.each([
    {
      label: 'classified authentication rejection',
      expected: 'authentication_rejected',
      execute: async () => {
        throw new HostIntegrationOperationError('authentication_rejected');
      },
    },
    {
      label: 'unexpected adapter error',
      expected: 'internal',
      execute: async () => {
        throw new Error('SENTINEL_RAW_UPSTREAM_ERROR');
      },
    },
  ])('records a terminal safe failure for $label', async ({ expected, execute }) => {
    const harness = createHarness();
    harness.behavior.execute = execute;

    const promise = harness.invoker.invoke({
      caller: agentA,
      profile: harness.profileId,
      operation: 'read',
      input: {},
    });
    await expect(promise).rejects.toMatchObject({ resultClass: expected, stage: 'execution' });
    await expect(promise).rejects.not.toThrow(/SENTINEL/);
    expect(listIntegrationInvocations()).toEqual([
      expect.objectContaining({
        caller_type: 'agent',
        agent_group_id: 'agent-a',
        session_id: 'session-a',
        status: 'failed',
        result_class: expected,
        finished_at: expect.any(String),
      }),
    ]);
  });

  it.each(['validator', 'oversize'] as const)(
    'fails closed on %s output and terminally audits contract drift',
    async (kind) => {
      const harness = createHarness({ maxOutputBytes: 32 });
      if (kind === 'validator') {
        harness.behavior.validateOutput = () => {
          throw new Error('SENTINEL_UPSTREAM_BODY');
        };
      } else {
        harness.behavior.validateOutput = () => ({ value: 'x'.repeat(100) });
      }

      const promise = harness.invoker.invoke({
        caller: agentA,
        profile: harness.profileId,
        operation: 'read',
        input: {},
      });
      await expect(promise).rejects.toMatchObject({
        resultClass: 'upstream_contract_changed',
        stage: 'output',
      });
      await expect(promise).rejects.not.toThrow(/SENTINEL/);
      expect(listIntegrationInvocations()[0]).toMatchObject({
        status: 'failed',
        result_class: 'upstream_contract_changed',
      });
    },
  );

  it('rereads and revalidates the credential on every invocation', async () => {
    const harness = createHarness();
    const seen: string[] = [];
    harness.behavior.execute = async ({ protectedPayload }) => {
      seen.push(protectedPayload.password);
      return { ok: true };
    };

    await harness.invoker.invoke({ caller: agentA, profile: harness.profileId, operation: 'read', input: {} });
    harness.store.payload = { password: 'ROTATED_SENTINEL' };
    await harness.invoker.invoke({ caller: agentA, profile: harness.profileId, operation: 'read', input: {} });

    expect(seen).toEqual(['SENTINEL_CREDENTIAL', 'ROTATED_SENTINEL']);
    expect(harness.store.readCalls).toBe(2);
    expect(listIntegrationInvocations()).toHaveLength(2);
  });
});

describe('HostIntegrationInvoker deadlines and concurrency', () => {
  it('serializes concurrent calls to the same profile', async () => {
    const harness = createHarness();
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    harness.behavior.execute = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { ok: true };
    };

    const first = harness.invoker.invoke({ caller: agentA, profile: harness.profileId, operation: 'read', input: 1 });
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = harness.invoker.invoke({ caller: agentA, profile: harness.profileId, operation: 'read', input: 2 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(releases).toHaveLength(1);
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()!();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(maximumActive).toBe(1);
    expect(listIntegrationInvocations().map((row) => row.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('fails immediately with busy when the bounded queue is full', async () => {
    const harness = createHarness({ maxQueued: 0 });
    let release!: () => void;
    harness.behavior.execute = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true };
    };
    const first = harness.invoker.invoke({ caller: agentA, profile: harness.profileId, operation: 'read', input: 1 });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));

    await expect(
      harness.invoker.invoke({ caller: agentA, profile: harness.profileId, operation: 'read', input: 2 }),
    ).rejects.toMatchObject({ resultClass: 'busy', stage: 'queue' });
    expect(listIntegrationInvocations()).toHaveLength(1);
    release();
    await expect(first).resolves.toBeDefined();
  });

  it('returns busy when a waiting caller exhausts its queue deadline', async () => {
    const gate = new ProfileInvocationGate();
    const active = await gate.acquire('profile-queue-test', Date.now() + 1_000);

    await expect(gate.acquire('profile-queue-test', Date.now() + 20)).rejects.toMatchObject({
      resultClass: 'busy',
      stage: 'queue',
    });
    active.release();
    const next = await gate.acquire('profile-queue-test', Date.now() + 100);
    next.release();
  });

  it('bounds credential preflight by the operation deadline and releases the slot', async () => {
    const harness = createHarness({ deadlineMs: 30 });
    vi.spyOn(harness.store, 'status').mockImplementationOnce(() => new Promise<CredentialStatus>(() => undefined));

    await expect(
      harness.invoker.invoke({ caller: agentA, profile: harness.profileId, operation: 'read', input: {} }),
    ).rejects.toMatchObject({ resultClass: 'upstream_timeout', stage: 'credential' });
    expect(listIntegrationInvocations()).toEqual([]);

    await expect(
      harness.invoker.invoke({ caller: agentA, profile: harness.profileId, operation: 'read', input: {} }),
    ).resolves.toMatchObject({ data: { items: [] } });
  });

  it('aborts on the total deadline, terminally audits, releases the slot, and permits the next call', async () => {
    const harness = createHarness({ deadlineMs: 30 });
    harness.behavior.execute = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('SENTINEL_ABORT_DETAIL')), { once: true });
      });

    const timedOut = harness.invoker.invoke({
      caller: agentA,
      profile: harness.profileId,
      operation: 'read',
      input: {},
    });
    await expect(timedOut).rejects.toMatchObject({ resultClass: 'upstream_timeout', stage: 'execution' });
    await expect(timedOut).rejects.not.toThrow(/SENTINEL/);
    expect(listIntegrationInvocations()[0]).toMatchObject({
      status: 'failed',
      result_class: 'upstream_timeout',
    });

    harness.behavior.execute = async () => ({ recovered: true });
    await expect(
      harness.invoker.invoke({ caller: agentA, profile: harness.profileId, operation: 'read', input: {} }),
    ).resolves.toMatchObject({ data: { recovered: true } });
  });

  it('turns caller cancellation into a terminal internal failure and releases the slot', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    harness.behavior.execute = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    const cancelled = harness.invoker.invoke({
      caller: agentA,
      profile: harness.profileId,
      operation: 'read',
      input: {},
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(listIntegrationInvocations()).toHaveLength(1));
    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ resultClass: 'internal', stage: 'execution' });
    expect(listIntegrationInvocations()[0]).toMatchObject({ status: 'failed', result_class: 'internal' });

    harness.behavior.execute = async () => ({ recovered: true });
    await expect(
      harness.invoker.invoke({ caller: agentA, profile: harness.profileId, operation: 'read', input: {} }),
    ).resolves.toMatchObject({ data: { recovered: true } });
  });
});

describe('safe error construction', () => {
  it('rejects adapter attempts to emit invoker-owned authorization classes', () => {
    expect(() => new HostIntegrationOperationError('not_authorized')).toThrow(/Invalid host integration/);
    expect(new HostIntegrationInvocationError('busy', 'queue').message).toBe('Integration is busy.');
  });
});
