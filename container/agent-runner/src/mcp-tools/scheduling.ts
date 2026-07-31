/**
 * Scheduling MCP tool: `schedule_task`, and nothing else.
 *
 * D4 — `ncl tasks` is the task control plane for every provider that can run a
 * CLI, so list/update/cancel/pause/resume are gone: deleted from the registry
 * outright, so nothing can expose them. `openai-protocol-loop` has no `ncl`
 * path and resolves its protocol tools from the MCP registry, so this one tool
 * stays REGISTERED as a shim for it.
 *
 * D4 also removed all six names from runtime-capabilities.ts. Be clear about
 * what that did and did not do: those lists feed the secondary-group setup menu
 * and the dead v1 ipc-mcp-stdio.ts path only. Actual MCP exposure is decided by
 * `filterToolsByCapability(allTools, NANOCLAW_CAPABILITIES)` in ./server.ts,
 * fed from the host's compiled capability plan — and the host's
 * `deriveCapabilityProfile` (src/capabilities/spawn-gate.ts) requests
 * `nanoclaw.schedule-task` for EVERY group. So `schedule_task` is still
 * offered to Claude and Codex agents alongside `ncl tasks`. That is accepted,
 * not intended: re-plumbing capability compilation was out of scope for this
 * port, and the tool is not a hazard now that it routes through the
 * group-scoped, contract-bearing, isolated-session handler on the host. A
 * maintainer who wants to actually withdraw it should start at server.ts's
 * filter and the capability profile, not at these lists.
 *
 * The container cannot write to inbound.db (host-owned), so the tool emits a
 * `kind='system'` outbound message and the host applies it during delivery
 * (see the `schedule_task` handler in src/modules/scheduling/schedule-action.ts).
 */
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { TIMEZONE, parseZonedToUtc } from '../timezone.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Short, readable, filesystem/thread-safe task id — must match the host's
 * makeTaskId charset (`^[a-z0-9-]+$`, see src/cli/resources/tasks.ts) because
 * it becomes both a thread suffix (`system:tasks:<id>`) and a filename
 * (`tasks/<id>.md`).
 */
function makeSeriesId(): string {
  return `t-${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;
}

function routing() {
  return getSessionRouting();
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const scheduleTask: McpToolDefinition = {
  tool: {
    name: 'schedule_task',
    description:
      `Schedule a one-shot or recurring task. The user's timezone is declared in the <context timezone="..."/> header of your prompt — interpret the user's "9pm" etc. in that zone. Cron expressions are interpreted in the user's timezone too.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'Task instructions/prompt' },
        processAfter: {
          type: 'string',
          description:
            `ISO 8601 timestamp for the first run. Accepts either UTC (ending in "Z" or "+00:00") or a naive local timestamp (no offset) which is interpreted in the user's timezone (e.g. "2026-01-15T21:00:00" = 9pm user-local). Prefer naive local.`,
        },
        recurrence: {
          type: 'string',
          description:
            'Cron expression for recurring tasks (e.g., "0 9 * * 1-5" = weekdays at 9am user-local). Evaluated in the user\'s timezone.',
        },
        script: { type: 'string', description: 'Optional pre-agent script to run before processing' },
      },
      required: ['prompt', 'processAfter'],
    },
  },
  async handler(args) {
    const prompt = args.prompt as string;
    const processAfterIn = args.processAfter as string;
    if (!prompt || !processAfterIn) return err('prompt and processAfter are required');

    let processAfter: string;
    try {
      const d = parseZonedToUtc(processAfterIn, TIMEZONE);
      if (Number.isNaN(d.getTime())) return err(`invalid processAfter: ${processAfterIn}`);
      processAfter = d.toISOString();
    } catch {
      return err(`invalid processAfter: ${processAfterIn}`);
    }

    const r = routing();
    const recurrence = (args.recurrence as string) || null;
    const script = (args.script as string) || null;
    // The series id is the agent-facing handle AND the host's task-session key;
    // generateId() only names the outbound row that carries the request.
    const seriesId = makeSeriesId();

    // Write as a system action — the host resolves the per-series task session
    // and inserts the row into ITS inbound.db.
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        action: 'schedule_task',
        seriesId,
        prompt,
        script,
        processAfter,
        recurrence,
        platformId: r.platform_id,
        channelType: r.channel_type,
        threadId: r.thread_id,
      }),
    });

    log(`schedule_task: ${seriesId} at ${processAfter}${recurrence ? ` (recurring: ${recurrence})` : ''}`);
    return ok(`Task scheduled (id: ${seriesId}, runs at: ${processAfter}${recurrence ? `, recurrence: ${recurrence}` : ''})`);
  },
};

registerTools([scheduleTask]);
