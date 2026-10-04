import path from 'node:path';

import { DATA_DIR } from '../src/config.js';
import { closeDb, getDb, initDb } from '../src/db/connection.js';
import { listIntegrationInvocations } from '../src/db/integration-invocations.js';
import { getIntegrationProfileRow, listIntegrationProfileGrants } from '../src/db/integration-profiles.js';
import { invokeFamilyAgendaFacade } from '../src/cli/resources/family-agenda.js';
import '../src/integrations/index.js';
import { HostIntegrationInvocationError, type HostIntegrationInvocationResult } from '../src/integrations/invoker.js';
import type { FamilyAgendaResult } from '../src/integrations/family-agenda.js';
import type { Session } from '../src/types.js';

const PROFILE_NAME = 'family-agenda';
const OPERATION_NAME = 'agenda.read';
const EVENT_FIELDS = ['activity', 'date', 'detail', 'end', 'location', 'start', 'title'] as const;

interface AgentGroupIdRow {
  id: string;
}

async function main(): Promise<void> {
  initDb(path.join(DATA_DIR, 'v2.db'));
  const profile = getIntegrationProfileRow(PROFILE_NAME);
  if (!profile || profile.enabled !== 1) throw new Error('Cutover profile is unavailable');
  const grants = listIntegrationProfileGrants(profile.id);
  if (grants.length !== 1 || grants[0]?.operation !== OPERATION_NAME) {
    throw new Error('Cutover grant is invalid');
  }

  const grantedGroupId = grants[0].agent_group_id;
  const grantedSession = getDb()
    .prepare(
      `SELECT * FROM sessions
       WHERE agent_group_id = ?
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 1`,
    )
    .get(grantedGroupId) as Session | undefined;
  if (!grantedSession) throw new Error('Granted group has no session');

  const deniedGroup = getDb()
    .prepare('SELECT id FROM agent_groups WHERE id <> ? ORDER BY id LIMIT 1')
    .get(grantedGroupId) as AgentGroupIdRow | undefined;
  if (!deniedGroup) throw new Error('No ungranted group is available');

  const result = (await invokeFamilyAgendaFacade(
    { days: 1 },
    {
      caller: 'agent',
      agentGroupId: grantedGroupId,
      sessionId: grantedSession.id,
      messagingGroupId: grantedSession.messaging_group_id ?? 'system',
    },
  )) as HostIntegrationInvocationResult;
  const agenda = requireAgendaEnvelope(result);

  const audit = listIntegrationInvocations(profile.id, 1)[0];
  if (
    !audit ||
    audit.status !== 'succeeded' ||
    audit.result_class !== 'success' ||
    audit.caller_type !== 'agent' ||
    audit.agent_group_id !== grantedGroupId ||
    audit.operation !== OPERATION_NAME
  ) {
    throw new Error('Cutover audit is not terminal');
  }

  let deniedSafely = false;
  try {
    await invokeFamilyAgendaFacade(
      { from: agenda.from, days: 1 },
      {
        caller: 'agent',
        agentGroupId: deniedGroup.id,
        sessionId: 'privacy-safe-denial-check',
        messagingGroupId: 'privacy-safe-denial-check',
      },
    );
  } catch (error) {
    deniedSafely =
      error instanceof HostIntegrationInvocationError &&
      error.resultClass === 'not_authorized' &&
      error.stage === 'authorization';
  }
  if (!deniedSafely) throw new Error('Ungranted call did not fail safely');

  process.stdout.write(
    `${JSON.stringify({
      status: 'success',
      window: { from: agenda.from, through: agenda.through },
      count: agenda.events.length,
      field_names: [...EVENT_FIELDS],
      observation_time: result.observed_at,
      audit_status: 'terminal_success',
      ungranted_status: 'not_authorized',
    })}\n`,
  );
}

function requireAgendaEnvelope(result: HostIntegrationInvocationResult): FamilyAgendaResult {
  if (
    !result ||
    result.adapter.id !== 'family-agenda' ||
    result.adapter.version !== 1 ||
    result.operation !== OPERATION_NAME ||
    typeof result.observed_at !== 'string'
  ) {
    throw new Error('Cutover envelope is invalid');
  }
  const agenda = result.data as FamilyAgendaResult;
  if (
    !agenda ||
    typeof agenda.from !== 'string' ||
    typeof agenda.through !== 'string' ||
    !Array.isArray(agenda.events)
  ) {
    throw new Error('Cutover output is invalid');
  }
  for (const event of agenda.events) {
    if (!event || Object.keys(event).sort().join(',') !== EVENT_FIELDS.join(',')) {
      throw new Error('Cutover event fields are invalid');
    }
  }
  return agenda;
}

main()
  .catch(() => {
    process.stderr.write('Family-agenda cutover verification failed.\n');
    process.exitCode = 1;
  })
  .finally(closeDb);
