/**
 * D4: the `schedule_task` system action — the one surviving MCP write path.
 *
 * `openai-protocol-loop` providers have no `ncl`, so they schedule through the
 * surviving `schedule_task` tool (container/agent-runner/src/mcp-tools/scheduling.ts),
 * which writes a `kind='system'` outbound message that lands here. Everything
 * else — list, update, cancel, pause, resume — moved to `ncl tasks`, and the
 * handlers that used to serve them (the module's deleted actions file) are gone.
 *
 * Not only protocol-loop agents reach this handler. Removing `schedule_task`
 * from runtime-capabilities.ts took it out of the setup menu, not out of the
 * runtime: exposure is decided by `filterToolsByCapability` in the container's
 * mcp-tools/server.ts, and deriveCapabilityProfile (src/capabilities/spawn-gate.ts)
 * requests `nanoclaw.schedule-task` for every group, so Claude and Codex agents
 * can still call it alongside `ncl tasks`. Accepted, not intended — which is
 * why this handler is written to be safe for ANY caller: group-scoped through
 * resolveTaskGroup, charset-guarded on the series id, isolated per-series
 * session, and delivery contract attached.
 *
 * Two things the deleted actions.ts did are deliberately NOT carried over:
 *   - the `ownerAgentGroupId` request parameter, and
 *   - withScheduleDb's cross-group write into another group's session.
 * A protocol-loop agent cannot name a foreign group any more. It gets its own
 * group, or its sole schedule-admin grant, from resolveTaskGroup(); cross-group
 * scheduling is now an `ncl tasks --group` operation, gated by the dispatcher.
 *
 * Registered as an import side effect via src/modules/index.ts, which
 * src/index.ts imports at startup. An unregistered action fails at runtime with
 * "Unknown system action" and no test catches it — see schedule-action.test.ts.
 */
import { randomUUID } from 'crypto';

import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { resolveTaskSession, withInboundDb } from '../../session-manager.js';
import { insertTask } from './db.js';
import { resolveTaskGroup } from './grants.js';
import { withTaskDeliveryContract } from './task-prompt.js';

/**
 * The series id becomes a thread suffix (`system:tasks:<id>`) and a run-log
 * filename (`tasks/<id>.md`), so an id off the container's charset is a path
 * escape, not a cosmetic problem. The container mints ids that match
 * (makeSeriesId there, makeTaskId in src/cli/resources/tasks.ts); anything
 * else — an older runner, a hand-written message — gets a fresh host-side id
 * rather than a rejection, so the task still gets scheduled.
 */
const SERIES_ID = /^[a-z0-9-]+$/;

function seriesIdFrom(value: unknown): string {
  if (typeof value === 'string' && SERIES_ID.test(value)) return value;
  return `t-${randomUUID().replace(/-/g, '').slice(0, 6)}`;
}

registerDeliveryAction('schedule_task', async (content, session) => {
  const seriesId = seriesIdFrom(content.seriesId);
  const group = resolveTaskGroup(session.agent_group_id, undefined);
  // Each series runs in its own isolated session, exactly as `ncl tasks create` does.
  const { session: taskSession } = resolveTaskSession(group, seriesId);
  withInboundDb(taskSession.agent_group_id, taskSession.id, (db) =>
    insertTask(db, {
      id: seriesId,
      processAfter: content.processAfter as string,
      recurrence: (content.recurrence as string) || null,
      // Same delivery contract `ncl tasks create` attaches. Load-bearing here:
      // the fire lands in an isolated task session where only send_message
      // reaches a human, and a protocol-loop agent has no `ncl` to learn that
      // from — without it the task runs and delivers to nobody.
      content: JSON.stringify({
        prompt: withTaskDeliveryContract(String(content.prompt ?? ''), seriesId),
        script: content.script ?? null,
      }),
    }),
  );
  log.info('Scheduled task created', {
    seriesId,
    agentGroupId: group,
    sessionId: taskSession.id,
    processAfter: content.processAfter,
    recurrence: content.recurrence ?? null,
  });
});
