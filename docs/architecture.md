# NanoClaw Architecture

This document describes the current implementation. Detailed table schemas
live in [db-central.md](db-central.md) and
[db-session.md](db-session.md); provider behavior lives in
[providers.md](providers.md) and
[agent-runner-details.md](agent-runner-details.md).

## System boundary

NanoClaw has two runtime processes:

- A Node host owns channels, identity, permissions, routing, the central
  database, session creation, container lifecycle, orchestration, and external
  delivery.
- A Bun agent-runner executes inside one container per active session. It
  polls session input, invokes the selected provider, runs granted tools, and
  writes session output.

The runtime data path is:

```text
messaging platform
  → channel adapter
  → host router
  → session inbound.db
  → Bun agent-runner
  → selected provider/runtime
  → session outbound.db
  → host delivery
  → channel adapter
  → messaging platform
```

Host-spawned containers do not receive prompts over stdin and do not return
responses over stdout. Session databases are the message transport. A
`.heartbeat` file is the separate liveness signal.

## Host process

The host entrypoint is `src/index.ts`. Its main responsibilities are:

- initialize `data/v2.db` and run numbered migrations;
- load installed channel and provider registrations;
- receive normalized inbound channel events;
- apply identity, membership, role, engagement, and command gates;
- resolve an agent group and session;
- write inbound work and wake the session container;
- poll outbound rows and deliver them through channel adapters;
- reconcile processing acknowledgements, scheduled work, orchestration
  leases, stale containers, and retries;
- expose the local `ncl` CLI server.

Important modules:

| Module                         | Responsibility                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `src/router.ts`                | Inbound authorization, engagement, session resolution, and durable dispatch            |
| `src/session-manager.ts`       | Session folders, DB access, routing projection, attachment extraction                  |
| `src/container-runner.ts`      | Runtime/profile resolution, capability compilation, materialization, spawn supervision |
| `src/container-launch-plan.ts` | Deterministic Docker command and mount validation                                      |
| `src/delivery.ts`              | Outbound polling, host actions, destination validation, external delivery ledger       |
| `src/host-sweep.ts`            | Ack reconciliation, liveness/stuck detection, due work, retry, orchestration recovery  |
| `src/orchestration/`           | Versioned plans, attempts, leases, cancellation, delivery gating, default-off fallback |
| `src/db/`                      | Central and session DB access                                                          |

## Identity, routing, and isolation

An `agent_group` is a durable agent identity and workspace. A
`messaging_group` is a channel/chat on a platform.
`messaging_group_agents` wires the two and declares engagement and session
behavior.

Session modes are:

- `agent-shared`: all wired messaging groups for an agent group converge on
  one conversation;
- `shared`: one conversation per messaging group;
- `per-thread`: one conversation per messaging group and platform thread.

Multiple sessions for the same agent group share the durable
`groups/<folder>/` workspace but have independent session DBs and provider
continuations. Different agent groups have different workspaces. See
[isolation-model.md](isolation-model.md).

Permissions belong to users and roles, not to chat names. The router derives
the caller from adapter identity, checks owner/admin/member access, applies
the wiring's engagement policy, and only then writes a session message.

## Database boundary

NanoClaw uses one central DB and two SQLite files per session:

| Database      | Writer    | Readers            | Purpose                                                              |
| ------------- | --------- | ------------------ | -------------------------------------------------------------------- |
| `data/v2.db`  | host      | host               | Identity, wiring, permissions, sessions, jobs, audit, orchestration  |
| `inbound.db`  | host      | host and container | Host-to-runner messages, delivery ledger, routing projections        |
| `outbound.db` | container | host and container | Runner-to-host messages, processing acknowledgements, provider state |

Each SQLite file has one normal writer side: the host owns `inbound.db`, while
runner processes own `outbound.db`. A narrow exception lets the host write an
immediate control acknowledgement to `outbound.db` only while the container is
confirmed stopped. Writers serialize allocation with `BEGIN IMMEDIATE`.
Session DBs use `journal_mode=DELETE`, not WAL, because WAL shared-memory
visibility is not reliable across container bind mounts. Host inbound writes
use open-write-close semantics for the same reason.

The container mounts `inbound.db` read-only and `outbound.db` read-write. The
host writes delivery outcomes to `inbound.db.delivered`; it never marks an
outbound row in place. The container reports inbound processing state through
`outbound.db.processing_ack`; host sweep reconciles those acknowledgements
back into `messages_in.status`.

Message sequence numbers use disjoint lanes across the session:

- host-created rows use even `seq` values;
- runner-created rows use odd `seq` values.

That parity allows tools such as edit/reaction to reference either direction
without ambiguous IDs. It does not establish global chronology across the two
SQLite files: inbound allocation reads `messages_in`, while runner outbound
allocation observes both tables. Use each row's timestamp and direction when
reconstructing a cross-direction timeline.

All runtime writers bind UTC ISO-8601 instants with an explicit `Z`; SQLite's
timezoneless `datetime('now')` text is used only for read-time comparisons.
Human CLI rendering localizes complete instants to the configured timezone,
while JSON and database values remain UTC ISO strings.

See [db.md](db.md) for invariants and
[db-session.md](db-session.md) for complete session schemas.

## Session filesystem and mounts

Host layout:

```text
data/
  v2.db
  v2-sessions/
    <agent-group-id>/
      .claude-shared/
      .codex-shared/
      .rtk/                    # provider-neutral RTK analytics + recovery output
      <session-id>/
        inbound.db
        outbound.db
        container.runtime.json
        provider-docs/
          CLAUDE.md
          AGENTS.md
        .heartbeat
        inbox/
        outbox/

  memory-migrations/           # ignored metadata ledgers and verified backups

groups/
  <folder>/
    CLAUDE.md
    AGENTS.md
    CLAUDE.local.md
    .claude-fragments/
    memory/
      index.md
      system/
        index.md
        definition.md
    container.json
    agent-runner-src/        # optional overlay
    ...durable work files
```

Inside a running container:

```text
/workspace/                    session folder
/workspace/agent/              canonical agent-group workspace
/workspace/group/              compatibility alias to the same group folder
/workspace/agent/container.json
/workspace/group/container.json
                               read-only mounts of container.runtime.json
/app/src/                      bind-mounted agent-runner source
/app/skills/                   bind-mounted container skills
/app/shared/                   shared resources
/app/docs/                     repository docs
```

`groups/<folder>/container.json` is a generated owner-only operator snapshot.
`container.runtime.json` is the effective session configuration and is the
file mounted at the two in-container `container.json` paths.

The container can write its session folder, so host-side attachment
materialization treats `inbox/` as untrusted filesystem state. Channel and
agent-to-agent attachment paths share a containment guard that rejects
symlinked roots/subdirectories, verifies resolved containment, and writes files
exclusively.

## Provider and runtime selection

Agent identity is separate from model execution. Effective selection order is:

1. session provider profile;
2. group provider profile;
3. legacy session provider override;
4. legacy group provider;
5. Claude.

Installed provider descriptors describe code and capabilities. DB-backed
provider profiles add endpoint, API family, model, effort, auth reference, and
tool-verification state. Runtime descriptors identify the execution harness:

- Claude → `claude-sdk`;
- Codex → `codex-app-server`;
- OpenAI-compatible profile → `openai-protocol-loop`.

The Claude runner remains on `@anthropic-ai/claude-agent-sdk`. The Codex path
uses `codex app-server`. Generic OpenAI-compatible profiles are text-only
until function calling is verified through the real credential route.

Before spawn, the host compiles a `SessionRuntimePlan` from:

- the effective provider/runtime;
- code-owned capability manifests;
- local capability availability;
- active orchestration-step requirements;
- selected skill requirements and approval state.

Required unsupported capabilities fail before spawn. A runtime without MCP
support receives no MCP configuration. A verified generic profile receives
only the compiled canonical protocol-tool bindings. Native runtime JSON also
contains the compiled plan: the built-in NanoClaw MCP subprocess filters both
tool discovery and invocation by granted capability ID, and configured
external MCP servers are attached only when the external-MCP capability was
compiled.

The host materializes effective provider-native project documents (`CLAUDE.md`
and `AGENTS.md`) below each private session directory and mounts them read-only
over the durable group workspace. This prevents concurrent sessions with
different compiled capability plans from overwriting each other's instructions.
Legacy group-level documents remain compatibility artifacts. Provider-specific state and auth
mounts are contributed by provider adapters. API-key profiles normally remain
behind OneCLI and are not stored in runtime JSON; explicitly enabled host-file
or direct-secret modes are mounted into the container.

Claude and Codex receive the `runtime.shell` capability through the built-in
NanoClaw MCP server. Its `run_shell` tool asks RTK to rewrite the command,
executes the resulting command with a bounded timeout and output capture, and
records tool-in-flight state for host stuck detection. RTK deny/approval
verdicts fail closed. Generic OpenAI-compatible profiles do not receive this
arbitrary-shell capability; their tool surface remains the bounded compiled
protocol contract.

Claude's native `Bash` path retains `rtk hook claude` as compatibility. Hook
registration preserves unrelated settings and refuses malformed settings
without overwriting them. RTK state is mounted from the agent-group `.rtk/`
directory at `/home/node/.local/share/rtk`, so gain analytics and full-output
recovery files survive container replacement and provider switches.

## Container lifecycle

`wakeContainerWithResult()` deduplicates concurrent wake requests per session.
For a new container, the host:

1. checks the group-scoped memory maintenance fence before reserving spawn
   capacity;
2. refreshes the session destination and default-routing projections;
3. materializes the group snapshot;
4. resolves provider/profile/runtime selection;
5. compiles and records the session capability authorization;
6. writes the per-session runtime JSON;
7. validates mounts, resource limits, network arguments, and OneCLI gateway
   contribution into a deterministic launch plan;
8. rechecks the durable memory maintenance fence immediately before the
   external process boundary;
9. spawns Docker and considers startup successful only after the child emits
   `spawn`;
10. tracks the concrete container instance and start time.

Memory maintenance holds return a distinct `maintenance-held` wake result.
Inbound and internal work remains durable and pending; a hold is neither a
capacity failure nor a provider failure. The control row defaults every group
to `disabled/none`, so this foundation does not enable or scaffold neutral
memory by itself.

The per-session runtime profile projects that control row into a neutral memory
mode and effective access. At runner startup, enabled writer sessions use the
image's `nanoclaw-memory-fs` helper to validate the canonical root and create
missing OKF v0.1 scaffold files exclusively. Enabled read-only sessions never
scaffold. The helper anchors traversal on directory descriptors, rejects
symlinks, accepts regular files only, and enforces safe ownership/modes from
the final memory root downward while allowing the intentionally writable
workspace ancestors. It uses Linux `openat2` constraints with a component-wise
`openat(O_NOFOLLOW)` fallback.

The runner alone reads and renders memory bodies. It omits an oversized index,
Unicode-safely truncates the definition, and wraps both in a bounded,
explicitly lower-trust envelope. It logs only byte counts and diagnostic
classifications. Provider delivery and filesystem-enforced non-writer
read-only mounts are separate controls. Enabled context is delivered only at
provider-safe boundaries: Claude new-session system context with a
programmatic SessionStart hook (including compact), Codex new-thread creation,
and once per OpenAI-compatible logical request. The host
never reads or embeds private memory bodies, and all control rows still
default to disabled.

Explicit validation is also body-blind to the host. `ncl memory validate`
resolves the group and image, then launches the same bind-mounted runner code
in a networkless operator container with a read-only root and group mount.
The thin validator uses the native safe-read helper, never mutates, and returns
only bounded path/classification metadata for scaffold, version, type, node,
link, reachability, duplicate-path, and always-loaded budget checks.

`ncl memory migrate-prepare` drives the group-scoped maintenance window from a
metadata-only ledger under ignored `data/memory-migrations/`. It fences every
wake, inventories routes/sessions/live scheduled series, records and pauses
only pending series, drains and stops containers, verifies a hashed tar backup,
enters `shadow/staging`, and moves only explicitly named legacy paths. Regular
files use same-filesystem renames; symlink objects are quarantined without
following their targets; directories and special nodes stop the workflow.
Every durable stage is rerunnable.

The invoking coding harness treats staged bodies as untrusted and writes a
source-to-destination JSON report. Every staged source is classified as a
standing instruction, private memory, or an explained omission. Materialized
destinations carry SHA-256 hashes, private-memory destinations are confined to
`memory/`, and a staged source path may be reconstructed only by an exact,
hashed standing-instruction entry. Unclassified or mismatched recreation fails
closed. `migrate-classify` records only the report path, hash, and entry count;
`migrate-validate` runs the isolated validator.
`migrate-approve` requires the exact workflow ID and a group writer session
before `active/migrated`. `migrate-finish` resumes only workflow-paused series
and releases the exact fence; `migrate-smoke` records passing
recall/correction/clear/compact/provider-switch checks. Pre-approval rollback
reverses recorded renames without overwrite. Post-approval rollback reacquires
the fence, stops containers, verifies and restores the backup while retaining
the displaced workspace, restores the recorded control state, and resumes only
the recorded series.

For enabled non-writer sessions, launch-plan compilation validates the host
memory root without reading its contents and overlays it read-only at both
workspace aliases. Any additional or provider mount at or below either
protected memory destination is rejected before Docker invocation, preventing
a child bind from reopening a writable path. Writer sessions retain the
writable group mount.

Writer transfer uses the same durable maintenance fence as migration. After
acquiring a temporary fence it drains in-flight wakes, requires every group
session to be stopped, and updates the writer with version and expected-writer
compare-and-swap checks. Status and transfer diagnostics contain control,
session, and path classification data only.

Shared-resource grants remain the explicit arrays in
`container_configs.shared_resources`; there is no `all` sentinel and ownership
does not reuse private-memory writer state. Launch compilation mounts each
selected backing directory individually. Uncontrolled/pilot resources and
non-owner grants are read-only. A central `shared_resource_control` row permits
write access only for one owner group after the resource progresses through
`pilot → reconciling → validated → reconciled`.

`ncl shared-resources reconcile-prepare` writes a content-blind node/grant and
legacy-authority inventory under ignored `data/`. The coding harness classifies
each source as private instruction, shared evidence, or omitted, and places its
bounded report under that directory. `reconcile-validate` hashes the report and
runs the same thin validator in an isolated networkless container against the
shared OKF root. `reconcile-approve` requires the exact version and resource
name, verifies the report did not change and attests pilot markers were
removed, then enables owner-only write access. Provider docs advertise only
the granted path, evidence-tier semantics, and safe filesystem metadata; they
never inline shared concept bodies.

The image runs Bun source directly; there is no container `tsc` build step.
`container/agent-runner/src` is bind-mounted at `/app/src`, so source changes
take effect in newly spawned containers without rebuilding the image. Native
helper changes do require `./container/build.sh`.

Host sweep uses heartbeat age, processing-claim age, pending-message age,
current tool timeout, and the current container instance's uptime to decide
whether work is stale. It does not rely on an in-process idle timer. A fresh
container receives a full processing window even when it picks up old
backlog.

After a provider completes a turn, the runner keeps its stream warm for a
60-second follow-up window. If no new message arrives, it exits cleanly and
releases its global container slot; the persisted provider continuation is
resumed on the next wake. This bounds idle slot occupancy without interrupting
active model or tool work. The outer poll loop applies the same bound when no
provider stream exists, including script-gated tasks and command-only batches.

`MAX_CONCURRENT_CONTAINERS` limits the union of active sessions and in-flight
spawn reservations. Admission is reserved synchronously before asynchronous
container setup; work deferred at capacity stays pending for a later sweep.
Optional CPU/memory limits become Docker `--cpus`/`--memory` arguments.
Optional egress lockdown places containers on an internal network whose
permitted gateway is OneCLI.

## Runner poll loop

The Bun runner:

1. opens the mounted session DBs;
2. migrates legacy continuation state for the selected runtime identity;
3. clears stale processing acknowledgements from a prior crashed process;
4. polls due trigger-bearing inbound messages;
5. writes `processing` acknowledgements;
6. formats the batch and starts the selected provider query;
7. continues polling and pushes eligible follow-ups into the active query;
8. writes outbound result/tool/system rows;
9. writes terminal processing acknowledgements.

Provider `push()` acceptance is not completion. A follow-up is completed only
after the provider acknowledges the result for the turn that consumed it.

Every initial provider turn must produce a terminal result or error. A stream
that closes silently produces a user-visible provider error. Host stop or a
runner command is an interruption and remains recoverable.

The stream may stay open after a result so later messages can reuse the same
provider process/session. Therefore orchestration completion is emitted at
the terminal turn event, before the corresponding user-facing outbound row;
it never waits for stream shutdown.

## Outbound routing and delivery

The host projects allowed destinations into `inbound.db.destinations`.
Runner output uses `<message to="name">...</message>` envelopes. The runner
resolves names locally, but the host re-validates every external or
agent-to-agent destination against central state before delivery.

Outbound rows are immutable. The host:

1. reads due rows from `outbound.db`;
2. skips rows already present in `inbound.db.delivered`;
3. applies orchestration delivery authorization when `in_reply_to` is
   correlated;
4. handles registered `system` actions or calls the channel adapter;
5. records `delivered` or `failed` in the inbound delivery ledger;
6. records orchestration delivery completion where applicable.

Missing channel routing and inactive channel adapters are delivery failures:
they retry and eventually enter the failed ledger instead of being
acknowledged as delivered.

Host-generated control responses, including command denials, go directly
through the destination adapter instead of being inserted into the
container-owned outbound database.

Running sessions are polled at approximately one second; all active sessions
are swept at approximately 60 seconds. Delivery is guarded against concurrent
drains of the same session.

Files produced by an agent live under `outbox/<message-id>/`. Outbound DB
content contains filenames, not host paths. The host validates and reads those
files, passes buffers to the adapter, and removes the outbox directory after
successful delivery. Reads are anchored to an opened regular-file descriptor
and bounded to 16 files, 25 MiB per file, and 50 MiB total per message.

## Host actions and tools

Tools never grant host authority directly. Native MCP tools and verified
protocol-loop tools write structured outbound rows. Registered host action
handlers validate the source session, caller permissions, correlation, and
compiled capability authorization before changing host state. Every
non-internal action requires a code-owned capability manifest and a grant in
the session snapshot; correlated actions additionally require an active run.

Examples include:

- message/file/card delivery;
- edit and reaction operations;
- scheduling and task administration;
- interactive questions;
- session search;
- durable agent-to-agent tasks;
- approved self-modification actions.

Canonical tool calls emit redacted lifecycle audit events. Raw prompts, model
output, secrets, and tool payloads are not copied into the audit log.

## Direct orchestration

Every engaged direct message is represented by a validated, versioned
`direct@1` plan:

```text
model step → delivery step
```

Central orchestration state records the plan, step attempts, leases, runtime
facts, normalized usage, cancellation, events, and delivery outcome. The
adapter-provided inbound message ID remains unchanged; nullable
`orchestration_run_id` supplies separate correlation.

For a correlated turn, the runner writes an `orchestration_result` system row
before its user-facing output. The host marks the model attempt terminal,
then permits or suppresses delivery. This ordering prevents delivery from
waiting on a provider stream intentionally held open for follow-ups.

Restricted fallback infrastructure exists for failures proven to occur before
tool side effects. Candidate compatibility, credentials, protocol, tool
schema, reconstructability, cancellation, and attempt limits are rechecked at
dispatch. A fallback candidate runs in a deterministic isolated
provider-profile session. The shipped code-owned policy has no candidates, so
fallback remains disabled until an operator evaluation is reviewed.

Inspect with:

```bash
ncl orchestration-runs list --agent-group-id <id>
ncl orchestration-runs cancel --id <run-id>
ncl orchestration-runs eval --agent-group-id <id>
```

## Scheduling and durable jobs

Simple scheduled session messages use `process_after` and optional
`recurrence` on inbound rows. Host sweep wakes due trigger-bearing work and
advances recurring occurrences without wall-clock drift.

When the runner formats a task occurrence, its `<task>` element carries both
`time` and `current_time` in the effective session timezone. `time` comes from
the row's effective `process_after` value (falling back to `timestamp` for a
legacy row); `current_time` is captured at prompt formatting. The distinction
keeps delayed runs and relative instructions anchored without changing stored
schedule semantics, and the Claude compaction hook preserves both attributes.

### `ncl tasks` control plane

Scheduled tasks are `messages_in` rows with `kind: 'task'`, but they run in
their **own per-series system session**, not the caller's chat session. `ncl
tasks create` (`src/cli/resources/tasks.ts`) resolves the caller's task group,
then `resolveTaskSession()` (`src/session-manager.ts`) finds or creates a
session with `messaging_group_id = NULL` and `thread_id =
system:tasks:<series_id>` — one such session per live series, materialized on
first fire and reused for every recurrence. The `openai-protocol-loop`
`schedule_task` shim (the one surviving MCP write path, `src/modules/
scheduling/schedule-action.ts`) creates a per-series session the same way, so
a protocol-loop-scheduled task gets the identical isolation.

**Script gate.** `create --script` attaches a pre-task bash script that runs
_before_ the agent wakes (`container/agent-runner/src/scheduling/
task-script.ts`): 30s timeout, 1MB output cap, and its last stdout line must be
JSON `{"wakeAgent": boolean, "data"?: unknown}`. `wakeAgent: false` (or a
missing/malformed line, or a nonzero exit) acks the occurrence without waking
the agent — a gated fire costs no tokens. `wakeAgent: true` folds `data` into
the task prompt as `scriptOutput` before the agent sees it. A gate script also
exempts the series from the recurrence-frequency limit (more than 4 fires/day
is otherwise refused) — the whole point of a gate is that most fires find
nothing and never wake the agent.

**Backoff and auto-pause.** A script that keeps _erroring_ (not a deliberate
`wakeAgent: false`) counts as a failed occurrence. `trailingFailedRuns()`
(`src/modules/scheduling/db.ts`) derives the current consecutive-failure
streak from occurrence history — no separate counter — and
`src/modules/scheduling/recurrence.ts` uses it to back the next fire off
(2, 4, 8, …, capped at 60 minutes). After 8 consecutive failures the series is
re-armed `paused` instead, with a host-written line in its run log explaining
why; `ncl tasks resume <id>` revives it once the script is fixed.

**One-door delivery.** A task fire has no chat attached, so `<message>` blocks
and bare final text are inert there. Every task prompt gets the delivery
contract baked in by `withTaskDeliveryContract()`
(`src/modules/scheduling/task-prompt.ts`): the _only_ way to reach a human from
inside a fire is `send_message` with an explicit destination. `delivery.ts`
enforces this from the host side — it drops (never delivers) a `task_log` row
that isn't coming from a session stamped `is_task` in `session_routing`, so a
task fire cannot accidentally leak final text out through a channel.

**Run log.** A fire's final text is auto-recorded, verbatim, as a `task_log`
outbound row; `delivery.ts` appends it to
`groups/<folder>/tasks/<series_id>.md` (`appendRunLog()`,
`src/modules/scheduling/run-log.ts`) instead of delivering it anywhere. Inside
a fire, `ncl tasks append-log --msg "..."` adds an extra host-timestamped line
for a mid-run note (and suppresses that fire's final-text auto-log). `ncl
tasks get <id>` tails the last ~10 lines alongside run/failure counts.

See [docs/ncl-tasks-migration.md](ncl-tasks-migration.md) for the migration
path from the pre-port scheduling MCP tools, including why legacy series
(created before this control plane existed) still fire from their original
chat session.

Long-running host work uses the central `jobs`/`job_events` lifecycle rather
than pretending a container tool call is durable. Agent-task delegation uses
its own central task/event lifecycle and dedicated assignee sessions. Job
start/status/cancel actions resolve their route through host-owned messaging
groups and the normal destination ACL before use. Progress and terminal
delivery revalidate the persisted route against the source session, so an
outbound action or stale job row cannot select an arbitrary channel.

The same lifecycle is available through the group-scoped `ncl jobs` control
plane. `ncl jobs start --type <type> --params '<json>'` launches registered
host work without requiring a model tool call and deduplicates an already
queued/running job of the same type by default. This is the deterministic path
for a scheduled task script that must initiate long work and then return
`wakeAgent:false`; `--allow-duplicate true` is an explicit opt-out. Jobs
started without a channel route remain silent, while their status and events
stay durable in the central DB for `ncl jobs list|get` inspection.

At host startup, every persisted `running` job without a child owned by the new
process is terminalized as failed with an `interrupted_on_startup` audit event.
Reconciliation is paged and idempotent; external work is never silently
replayed after a restart.

`/screen-market` is the first guided host-owned job path. Its wizard state
lives in the migration-017 tables (`src/modules/stock-screen-guided/`) and the
host-side flow is gated behind `SCREEN_MARKET_GUIDED_HOST`, which defaults to
false — the tables exist in every install but the guided prompts stay off
until an operator enables them.

Auxiliary invocations (`auxiliary_routes`, `auxiliary_invocations`, migration 023) are staged scaffolding: the `ncl auxiliary-routes` config surface is live,
but no production caller dispatches through `executeAuxiliaryInvocation` yet.
Its trust boundary is structural — source identity is stamped from the trusted
session and the target comes only from the operator-configured route, so there
is no caller-supplied field for a container to spoof a group or override its
route with.

## Security invariants

- One writer per SQLite file.
- Session DBs use DELETE journaling across bind mounts.
- API-key credentials normally use OneCLI and are not stored in prompts or
  runtime configuration; explicit direct-secret/host-auth modes are exceptions.
- Mount destinations are unique and additional mounts are validated.
- The host is authoritative for permissions, destinations, capabilities, and
  external delivery.
- Provider output cannot self-assert orchestration identity or host authority.
- Tool-less or unverified runtimes fail closed.
- Different agent groups are filesystem and session-state boundaries.
- Running containers are disposable; durable state lives in mounted
  workspaces and databases.

## Further reading

- [architecture-diagram.md](architecture-diagram.md) — compact diagrams
- [db.md](db.md) — DB map and cross-mount invariants
- [db-central.md](db-central.md) — central schema
- [db-session.md](db-session.md) — session schemas
- [agent-profile.md](agent-profile.md) — identity/runtime materialization
- [providers.md](providers.md) — descriptors, profiles, tool verification
- [agent-runner-details.md](agent-runner-details.md) — runner/provider details
- [isolation-model.md](isolation-model.md) — channel/session isolation choices
- [OPERATIONS.md](OPERATIONS.md) — canonical build, test, and service commands
- [ncl-tasks-migration.md](ncl-tasks-migration.md) — `ncl tasks` migration and legacy-task notes
