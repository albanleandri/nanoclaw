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

Each SQLite file has exactly one writer. Session DBs use
`journal_mode=DELETE`, not WAL, because WAL shared-memory visibility is not
reliable across container bind mounts. Host inbound writes use
open-write-close semantics for the same reason.

The container mounts `inbound.db` read-only and `outbound.db` read-write. The
host writes delivery outcomes to `inbound.db.delivered`; it never marks an
outbound row in place. The container reports inbound processing state through
`outbound.db.processing_ack`; host sweep reconciles those acknowledgements
back into `messages_in.status`.

Message sequence numbers share a session-wide namespace:

- host-created inbound rows use even `seq` values;
- container-created outbound rows use odd `seq` values.

That parity allows tools such as edit/reaction to reference either direction
without ambiguous IDs.

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
        .heartbeat
        inbox/
        outbox/

groups/
  <folder>/
    CLAUDE.md
    AGENTS.md
    CLAUDE.local.md
    .claude-fragments/
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

`groups/<folder>/container.json` is a generated operator snapshot.
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
only the compiled canonical protocol-tool bindings.

The host materializes provider-native project documents (`CLAUDE.md` and
`AGENTS.md`) as compatibility artifacts. Provider-specific state and auth
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

1. refreshes the session destination and default-routing projections;
2. materializes the group snapshot;
3. resolves provider/profile/runtime selection;
4. compiles and records the session capability authorization;
5. writes the per-session runtime JSON;
6. validates mounts, resource limits, network arguments, and OneCLI gateway
   contribution into a deterministic launch plan;
7. spawns Docker and considers startup successful only after the child emits
   `spawn`;
8. tracks the concrete container instance and start time.

The image runs Bun source directly; there is no container `tsc` build step.
`container/agent-runner/src` is bind-mounted at `/app/src`, so source changes
take effect in newly spawned containers without rebuilding the image.

Host sweep uses heartbeat age, processing-claim age, pending-message age,
current tool timeout, and the current container instance's uptime to decide
whether work is stale. It does not rely on an in-process idle timer. A fresh
container receives a full processing window even when it picks up old
backlog.

`MAX_CONCURRENT_CONTAINERS` limits active sessions. Optional CPU/memory limits
become Docker `--cpus`/`--memory` arguments. Optional egress lockdown places
containers on an internal network whose permitted gateway is OneCLI.

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

Running sessions are polled at approximately one second; all active sessions
are swept at approximately 60 seconds. Delivery is guarded against concurrent
drains of the same session.

Files produced by an agent live under `outbox/<message-id>/`. Outbound DB
content contains filenames, not host paths. The host validates and reads those
files, passes buffers to the adapter, and removes the outbox directory after
successful delivery.

## Host actions and tools

Tools never grant host authority directly. Native MCP tools and verified
protocol-loop tools write structured outbound rows. Registered host action
handlers validate the source session, caller permissions, correlation, and
compiled capability authorization before changing host state.

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

Long-running host work uses the central `jobs`/`job_events` lifecycle rather
than pretending a container tool call is durable. Agent-task delegation uses
its own central task/event lifecycle and dedicated assignee sessions.

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
