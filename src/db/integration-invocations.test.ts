import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHostIntegrationRegistry, type HostIntegrationRegistry } from '../integrations/registry.js';
import type { HostIntegrationAdapter } from '../integrations/types.js';
import { createAgentGroup } from './agent-groups.js';
import { closeDb, getDb, initTestDb } from './connection.js';
import {
  finishIntegrationInvocation,
  getIntegrationInvocation,
  listIntegrationInvocations,
  reconcileInterruptedIntegrationInvocations,
  startIntegrationInvocation,
} from './integration-invocations.js';
import { createIntegrationProfile } from './integration-profiles.js';
import { runMigrations } from './migrations/index.js';
import { createSession } from './sessions.js';

function registry(): HostIntegrationRegistry {
  const result = createHostIntegrationRegistry();
  const adapter: HostIntegrationAdapter<{ tenant: string }, { password: string }> = {
    id: 'audit-test',
    version: 1,
    securityTier: 'trusted-host',
    hostAuthJustification: 'Test-only host form login.',
    validateConfig(value) {
      if (!value || typeof value !== 'object' || Object.keys(value).join(',') !== 'tenant') throw new Error('config');
      return { tenant: String((value as { tenant: unknown }).tenant) };
    },
    validateProtectedPayload(value) {
      if (!value || typeof value !== 'object' || typeof (value as { password?: unknown }).password !== 'string') {
        throw new Error('protected');
      }
      return { password: (value as { password: string }).password };
    },
    protectedFields: [{ name: 'password', sensitivity: 'secret', label: 'Password' }],
    operations: {
      read: {
        name: 'read',
        sideEffects: 'none',
        validateInput: (value) => value,
        validateOutput: (value) => value,
        totalDeadlineMs: 1_000,
        network: {
          maxRedirects: 0,
          destinations: [
            {
              origin: 'https://audit.example.test',
              methods: ['GET'],
              isAllowedUrl: (url) => url.origin === 'https://audit.example.test',
            },
          ],
        },
        responseLimits: {
          maxHeaderBytes: 1_024,
          maxCookieBytes: 1_024,
          maxBodyBytes: 1_024,
          maxNormalizedOutputBytes: 1_024,
        },
        execute: async () => [],
      },
    },
  };
  result.register(adapter);
  return result;
}

function seed(registryValue: HostIntegrationRegistry): void {
  createAgentGroup({
    id: 'agent-a',
    name: 'Agent A',
    folder: 'agent-a',
    agent_provider: null,
    created_at: '2026-10-03T08:00:00Z',
  });
  createAgentGroup({
    id: 'agent-b',
    name: 'Agent B',
    folder: 'agent-b',
    agent_provider: null,
    created_at: '2026-10-03T08:00:00Z',
  });
  createSession({
    id: 'session-a',
    agent_group_id: 'agent-a',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-10-03T08:00:00Z',
  });
  createIntegrationProfile(
    {
      id: 'profile-1',
      name: 'Audit profile',
      adapterId: 'audit-test',
      adapterVersion: 1,
      config: { tenant: 'safe-tenant' },
      credentialBackend: 'local-file',
      createdAt: '2026-10-03T08:00:00Z',
    },
    registryValue,
  );
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(closeDb);

describe('integration invocation audit', () => {
  it('records only profile/caller/lifecycle metadata and completes once', () => {
    const registryValue = registry();
    seed(registryValue);
    const started = startIntegrationInvocation(
      {
        id: 'invocation-1',
        profileId: 'profile-1',
        operation: 'read',
        callerType: 'agent',
        agentGroupId: 'agent-a',
        sessionId: 'session-a',
        startedAt: '2026-10-03T08:00:00.000Z',
      },
      registryValue,
    );
    expect(started).toMatchObject({
      profile_name: 'Audit profile',
      adapter_id: 'audit-test',
      operation: 'read',
      status: 'running',
      result_class: null,
    });
    const completed = finishIntegrationInvocation(started.id, {
      status: 'succeeded',
      resultClass: 'success',
      finishedAt: '2026-10-03T08:00:01.000Z',
    });
    expect(completed).toMatchObject({ status: 'succeeded', result_class: 'success', duration_ms: 1000 });
    expect(() => finishIntegrationInvocation(started.id, { status: 'failed', resultClass: 'internal' })).toThrow(
      /conflict/,
    );

    const columns = Object.keys(getIntegrationInvocation(started.id)!);
    expect(columns).not.toEqual(expect.arrayContaining(['credential_ref', 'config_json', 'arguments', 'result']));
    const credentialReference = getDb()
      .prepare('SELECT credential_ref FROM integration_profiles WHERE id = ?')
      .get('profile-1') as { credential_ref: string };
    expect(JSON.stringify(listIntegrationInvocations())).not.toContain(credentialReference.credential_ref);
  });

  it('rejects unregistered result classifications before writing them', () => {
    const registryValue = registry();
    seed(registryValue);
    const started = startIntegrationInvocation(
      { id: 'invocation-1', profileId: 'profile-1', operation: 'read', callerType: 'host' },
      registryValue,
    );
    expect(() =>
      finishIntegrationInvocation(started.id, {
        status: 'failed',
        resultClass: 'raw-upstream-secret' as 'internal',
      }),
    ).toThrow(/does not match/);
    expect(getIntegrationInvocation(started.id)?.status).toBe('running');
  });

  it('rejects unknown operations and mismatched trusted caller identity', () => {
    const registryValue = registry();
    seed(registryValue);
    expect(() =>
      startIntegrationInvocation({ profileId: 'profile-1', operation: 'write', callerType: 'host' }, registryValue),
    ).toThrow(/Unknown host integration operation/);
    expect(() =>
      startIntegrationInvocation(
        {
          profileId: 'profile-1',
          operation: 'read',
          callerType: 'agent',
          agentGroupId: 'agent-b',
          sessionId: 'session-a',
        },
        registryValue,
      ),
    ).toThrow(/does not belong/);
    expect(() =>
      startIntegrationInvocation(
        {
          profileId: 'profile-1',
          operation: 'read',
          callerType: 'host',
          agentGroupId: 'agent-a',
        },
        registryValue,
      ),
    ).toThrow(/cannot carry agent identity/);
  });

  it('reconciles every stale running row to a terminal interrupted state', () => {
    const registryValue = registry();
    seed(registryValue);
    for (const id of ['invocation-1', 'invocation-2']) {
      startIntegrationInvocation(
        {
          id,
          profileId: 'profile-1',
          operation: 'read',
          callerType: 'host',
          startedAt: '2026-10-03T08:00:00.000Z',
        },
        registryValue,
      );
    }
    expect(reconcileInterruptedIntegrationInvocations('2026-10-03T08:00:03.000Z')).toBe(2);
    expect(reconcileInterruptedIntegrationInvocations('2026-10-03T08:00:04.000Z')).toBe(0);
    expect(listIntegrationInvocations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'interrupted',
          result_class: 'interrupted_on_restart',
          duration_ms: 3000,
          finished_at: '2026-10-03T08:00:03.000Z',
        }),
      ]),
    );
  });

  it('retains redacted profile metadata after a profile is deleted', () => {
    const registryValue = registry();
    seed(registryValue);
    startIntegrationInvocation(
      {
        id: 'invocation-1',
        profileId: 'profile-1',
        operation: 'read',
        callerType: 'host',
      },
      registryValue,
    );
    getDb().prepare('DELETE FROM integration_profiles WHERE id = ?').run('profile-1');
    expect(getIntegrationInvocation('invocation-1')).toMatchObject({
      profile_id: null,
      profile_name: 'Audit profile',
      adapter_id: 'audit-test',
    });
  });
});
