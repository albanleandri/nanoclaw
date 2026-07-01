import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from '../../db/index.js';
import { compileDirectPlan } from '../patterns/direct.js';
import {
  createOrchestrationRun,
  markRunDispatched,
  recordDirectDelivery,
  recordModelBatchResult,
} from '../run-store.js';
import { advancedFeatureEvalReport } from './report.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'agent', name: 'Agent', folder: 'agent', agent_provider: null, created_at: '2026-01-01' });
  createSession({
    id: 'session',
    agent_group_id: 'agent',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-01-01',
  });
});
afterEach(closeDb);

describe('advanced feature eval report', () => {
  it('reports bounded direct baseline metrics without activating a feature', () => {
    const plan = compileDirectPlan({
      taskId: 'eval',
      objective: 'hello',
      kind: 'chat',
      agentGroupId: 'agent',
      sessionId: 'session',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const run = createOrchestrationRun(plan, 'input:eval');
    markRunDispatched(run.run_id);
    recordModelBatchResult({
      eventId: 'eval-result',
      sourceSessionId: 'session',
      inputMessageIds: ['input:eval'],
      outcome: 'result',
      usage: { inputTokens: 10, outputTokens: 2, source: 'provider' },
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    recordDirectDelivery({
      sourceSessionId: 'session',
      inputMessageId: 'input:eval',
      outboundMessageId: 'out:eval',
      status: 'succeeded',
      createdAt: '2026-01-01T00:00:02.000Z',
    });
    expect(advancedFeatureEvalReport('agent')).toMatchObject({
      policy: { gates: { fallback: { enabled: false } } },
      directBaseline: {
        sampleSize: 1,
        terminalRuns: 1,
        succeededRuns: 1,
        successRate: 1,
        averageTerminalLatencyMs: 2_000,
        usage: { inputTokens: 10, outputTokens: 2 },
      },
      activation: { automatic: false },
      fallbackGate: {
        status: 'requires-controlled-evaluation',
        thresholds: {
          duplicateSideEffects: 0,
          minimumEligibleFailureRecoveryRate: 0.5,
          maximumLatencyMultiplier: 2,
          maximumUsageMultiplier: 2,
        },
      },
      acceptanceFixtures: expect.arrayContaining([
        {
          id: 'conflicting-reference-outputs',
          expected: 'treat_as_untrusted_evidence_without_side_effect_authority',
        },
      ]),
    });
  });
});
