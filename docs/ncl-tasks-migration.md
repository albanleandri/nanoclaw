# `ncl tasks` migration

## Detect

If an agent mentions `list_tasks`, `update_task`, `cancel_task`, `pause_task`,
or `resume_task`, it is using the old scheduling MCP surface. Those five tools
were removed outright — the host no longer has handlers for them.

`schedule_task` alone is **not** a stale-image symptom. It deliberately
survives as a narrow, create-only shim for `openai-protocol-loop` providers,
which have no `ncl` binary and resolve their protocol tools from the MCP
registry (`container/agent-runner/src/mcp-tools/scheduling.ts`). Claude and
Codex agents can still call it too — accepted, not intended — but `ncl tasks`
is the preferred path for all task management on every provider that has it.

A subtler symptom of a stale container image: the agent reports it paused,
updated, or cancelled a task, but nothing changed, and the host log shows
`Unknown system action` — an old image's `list_tasks` / `cancel_task` /
`pause_task` / `resume_task` / `update_task` call is acknowledged in-container
and then dropped by the new host, because only the `schedule_task` handler
survived. (An old image's `schedule_task` call still works against the new
host — its payload's `taskId` field predates the current `seriesId` field, so
the host falls back to a freshly generated series id rather than rejecting the
call.) The fix below (rebuild + restart) resolves both symptoms.

## Why

Scheduling moved to `ncl tasks`. New tasks are stored in a per-agent-group
system session and run there, so a scheduled task does not wake an existing
chat session. When it fires, the agent must choose the delivery destination
explicitly.

## Fix

Rebuild and restart agent containers so they load the updated MCP tool list
and instructions:

```bash
./container/build.sh
systemctl --user restart nanoclaw
```

This fork runs on Linux, so `systemctl --user` is the primary path. On macOS
with launchd instead of systemd, use
`launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (adjust the label to your
install's actual service name). `pnpm run service:restart` /
`pnpm run service:status` resolve the right path automatically, in the same
priority order — see [OPERATIONS.md](OPERATIONS.md).

Use:

```bash
ncl tasks list
ncl tasks create --group <agent_group_id> --prompt "..." --process-after "2026-01-15T09:00:00" --recurrence "0 9 * * *"
ncl tasks update <series_id> --prompt "..."
ncl tasks cancel <series_id>
```

## Verify

Run `ncl tasks list`. New task rows should show a system `session_id`, not the
chat session that requested the task.

## Legacy tasks (scheduled before this update)

Legacy series created before this update live in the **chat session** that
created them, not in a per-series system session. They keep firing and
delivering exactly as before, because task-fire detection is gated on the
host-stamped `session_routing.is_task` flag rather than on message kind. Do not
relax that gate to match upstream: a legacy series is `kind='task'` in a chat
session, and treating it as a task fire makes its final text undeliverable —
`delivery.ts` drops a `task_log` row that arrives outside a task session.

Two things to know:

- **Legacy tasks are invisible to the agent that owns them.** An agent's own
  `ncl tasks list` / `get` / `update` / `cancel` resolves sessions through
  `findTaskSessions()`, which only matches sessions whose thread id is
  `system:tasks` or `system:tasks:<id>`. A legacy series living in an ordinary
  chat session never matches that filter, so the agent group that "owns" it
  can neither list nor cancel it through `ncl tasks` — it is stuck, not just
  hidden. (The five removed MCP tools could reach it, because they read the
  caller's own `inbound.db` directly instead of scoping by thread id.) From
  the **host**, unscoped `ncl tasks list` enumerates every active session
  regardless of thread id, and `--session <chat_session_id>` narrows to one —
  that is the only way left to find and manage a legacy row:
  `ncl tasks list --session <chat_session_id>` to see it,
  `ncl tasks cancel --session <chat_session_id> --all` to clear it.
- The `messages_in` status enum now includes `cancelled` (cancel marks the row
  and clears its recurrence rather than deleting it). Custom code that
  exhaustively switches on task status needs the new arm.

## Rollback

Order matters:

1. Remove tasks created through `ncl tasks` (`ncl tasks list` / `delete`) —
   they live in per-series system sessions the old code doesn't know about.
2. **Wait one sweep (≤60s)** so the host closes the now-empty task sessions.
3. Then revert the update and rebuild the container image.

Reverting before the task sessions are collected leaves system sessions behind
that the old `findSessionByAgentGroup` (which has no system-session exclusion)
can resolve as the group's session — mis-routing agent-to-agent messages into
a dead task thread.
