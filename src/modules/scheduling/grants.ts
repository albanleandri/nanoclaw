/**
 * Schedule-admin-grant resolution for `ncl tasks`.
 *
 * Extracted from the deleted src/modules/scheduling/actions.ts when scheduling
 * moved from MCP tools to the CLI. Upstream has no grant concept — this is the
 * fork's cross-agent-group task delegation (migration 020-schedule-admin-grants,
 * `ncl schedule-admin-grants`), preserved through the port.
 *
 * Kept in its own module so BOTH src/cli/dispatch.ts (pre-handler scope gate)
 * and src/cli/resources/tasks.ts (handler-side owner resolution) can use it
 * without either importing the other.
 */
import { getScheduleAdminGrants, isScheduleAdminAuthorized } from '../../db/schedule-admin-grants.js';

/** Pure predicate: may `caller` operate on `requested`'s tasks? */
export function isTaskGroupAuthorized(callerAgentGroupId: string, requestedGroupId: string): boolean {
  if (requestedGroupId === callerAgentGroupId) return true;
  return isScheduleAdminAuthorized(callerAgentGroupId, requestedGroupId);
}

/**
 * Which agent group's tasks this call operates on.
 *
 * - Explicit request → allowed only for the caller's own group or a granted
 *   owner. Throws otherwise; the message names the rejected group so an agent
 *   can tell "not authorized" from "does not exist".
 * - No request → the caller's sole grant when it has exactly one (the fork's
 *   long-standing default, so a delegated agent needn't repeat --group), the
 *   caller's own group when it has none, and an error when it has several —
 *   guessing between owners would silently write to the wrong group.
 */
export function resolveTaskGroup(callerAgentGroupId: string, requestedGroupId: string | undefined): string {
  if (requestedGroupId) {
    if (!isTaskGroupAuthorized(callerAgentGroupId, requestedGroupId)) {
      throw new Error(`schedule owner not authorized: ${requestedGroupId}`);
    }
    return requestedGroupId;
  }
  const grants = getScheduleAdminGrants(callerAgentGroupId);
  if (grants.length === 1) return grants[0].owner_agent_group_id;
  if (grants.length > 1) throw new Error('multiple schedule owners available; --group is required');
  return callerAgentGroupId;
}
