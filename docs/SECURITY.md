# NanoClaw Security Model

NanoClaw treats model/provider output as untrusted. Containers reduce the
filesystem and process impact of a compromised or mistaken agent; host-side
authorization remains authoritative for identity, capabilities, routing, and
external side effects.

This document describes the current implementation, not a claim that
containers make arbitrary model execution risk-free.

## Trust boundaries

```text
messaging platform / user input          untrusted
provider/model output                    untrusted
agent container                          isolated execution domain
session DB rows from the container       untrusted requests
host process                             trusted policy enforcement
central DB                               trusted admin/durable state
OneCLI gateway                           trusted credential boundary
```

The host does not grant authority because a prompt or model response says it
has authority. It derives the source session, user, agent group, wiring,
compiled capability authorization, and destination from host-owned state.

## Container isolation

Each active session runs in its own Docker container by default. Apple
Container and Docker Sandboxes are optional runtime choices documented
separately.

The container receives explicit mounts only:

- its session folder at `/workspace`;
- its agent-group workspace at `/workspace/agent` and compatibility alias
  `/workspace/group`;
- the effective session runtime JSON as read-only nested mounts;
- agent-runner source, enabled skills, selected shared resources, and docs;
- provider-specific state/auth stubs contributed by installed provider code;
- operator-approved additional mounts.

The repository root and central `data/v2.db` are not mounted by the standard
launch path. Additional mounts are normalized and validated before spawn, and
duplicate container destinations are rejected so a later nested mount cannot
silently shadow a security-relevant mount.

The agent-group workspace is intentionally writable: it is the agent's durable
memory and work area. Sessions for the same agent group share it. Different
agent groups use different folders and provider-state roots.

Optional `CONTAINER_CPU_LIMIT` and `CONTAINER_MEMORY_LIMIT` become Docker
resource limits. They constrain resource use; they are not authorization
controls.

## Database isolation

Every session owns two SQLite files:

- `inbound.db`: host writer, container read-only;
- `outbound.db`: container writer, host reader.

Each file has one writer and uses DELETE journaling across the bind mount.
The container cannot mark its own outbound message delivered or directly
change inbound status. Instead:

- processing state is reported through `outbound.db.processing_ack`;
- delivery outcome is written by the host to `inbound.db.delivered`;
- liveness is a `.heartbeat` file touch;
- host sweep reconciles acknowledgements and stale work.

The central DB is host-only. Container requests to modify central state are
structured outbound system actions processed by registered host handlers.

## Identity and permissions

Messaging identities are normalized into namespaced users. Privilege is
user-level:

- `owner` is global;
- `admin` may be global or scoped to an agent group;
- unprivileged access requires agent-group membership.

`messaging_group_agents` wiring declares which agent handles a platform chat
and its engagement/session behavior. Unknown-sender policy is stored on the
messaging group (`strict`, `request_approval`, or `public`).

The router checks identity, role/membership, engagement rules, command
authority, and wiring before writing an inbound row. Agent instructions cannot
override these checks.

## Destination authorization

Allowed channel and peer-agent destinations are projected into each session's
`inbound.db.destinations` table for local name resolution. This projection is
not the final security decision.

Before external delivery or agent-to-agent routing, the host revalidates the
destination against central wiring/ACL state. A stale or forged session row
therefore cannot create a new destination. Agent-to-agent replies use a
host-derived source-session return path.

Different sessions of the same agent group share workspace trust. Use separate
agent groups whenever participants or confidentiality boundaries differ. See
[isolation-model.md](isolation-model.md).

## Capability and tool authorization

Before spawn, the host compiles code-owned capability manifests against:

- the selected runtime/provider profile;
- deterministic local availability;
- session policy and CLI scope;
- active orchestration-step requirements;
- enabled skill requirements and approval/provenance state.

Required unsupported capabilities fail before the container starts.
Tool-less runtimes receive no MCP configuration. Installed manifested skills
that are unapproved, drifted, incompatible, or missing requirements fail
closed. A configured skill that is no longer installed is omitted with a
warning rather than preventing all startup.

Native providers translate compiled intent into provider-native policy.
Generic OpenAI-compatible profiles remain text-only until function calling is
verified through the real endpoint/credential route. Verified generic
profiles receive only compiled canonical NanoClaw tools with strict argument
validation, bounded iterations/calls/results, and duplicate-call suppression.
Verification does not enable arbitrary MCP discovery.

Canonical tool invocations emit redacted audit lifecycle events. The audit
stores capability/version, source correlation, state, and a hash of validated
non-sensitive arguments—not raw prompts, model output, tool arguments, or
secrets.

## Host actions

Agent tools request host behavior by writing structured `system` rows to
`outbound.db`. Host handlers:

1. identify the source session and agent group;
2. validate the action schema;
3. derive the correlated user/orchestration context;
4. check role, destination, and compiled capability authorization;
5. perform the bounded host operation;
6. return a structured response through `inbound.db` when needed.

Known correlated actions require an active source-derived orchestration run
and the capability in that session's compiled authorization snapshot. Late or
cancelled actions fail closed.

## Orchestration safety

Direct engaged messages use a host-owned versioned plan and central step
attempts. Provider output cannot choose a run ID: correlation is carried in a
host-written nullable inbound column.

User-facing correlated delivery waits while its model attempt is active and
is suppressed after cancellation or loss of delivery ownership. The runner
writes terminal orchestration metadata before the reply, so authorization
does not depend on provider stream shutdown.

Restricted fallback is default-off. Even when a policy names candidates, it
is allowed only for reconstructable input and a failure proven to occur
before tool/host/artifact/delivery side effects. Runtime/protocol,
capabilities, concrete tool schema, credentials, cancellation, and attempt
budgets are rechecked at dispatch. Unknown side-effect state fails closed.

## Credential boundary

Provider API-key credentials normally use OneCLI and are not stored in
`container.json`, prompts, or the central DB. Before Docker spawn, the host:

1. ensures the stable OneCLI agent identity using the agent-group ID;
2. asks OneCLI to apply gateway policy and credential mounts/environment;
3. refuses to spawn if the gateway contribution fails;
4. supplies placeholder SDK auth values where the native SDK requires them.

The gateway injects the real credential on an authorized outbound request.
Provider profiles store only a secret reference.

`CONTAINER_SECRET_*` variables are an explicit exception: values are forwarded
directly into the container environment for integrations that cannot use the
gateway. Any process in that container can read them. Prefer OneCLI or another
scoped proxy whenever possible.

`CODEX_CHATGPT_AUTH=host-file` is another explicit exception. It copies the
host Codex ChatGPT `auth.json` into the selected agent group's private
`.codex-shared` directory. The Codex process can read those subscription
tokens; use this mode only for agent groups that should receive that authority.

Provider-native local state such as `.claude-shared` and `.codex-shared` is
scoped per agent group. DB-backed runtime/profile keys further prevent one
endpoint profile from resuming another profile's continuation state.

## Network controls

By default, a container can use Docker's normal outbound network. This is
necessary for provider APIs and web/tool access but means container isolation
alone is not an egress allowlist.

With `NANOCLAW_EGRESS_LOCKDOWN=true`, NanoClaw creates an internal Docker
network and routes the permitted gateway through OneCLI. Direct host services
such as a local Ollama endpoint are not reachable in that mode unless an
explicitly reviewed gateway route is added.

Docker `--add-host=host.docker.internal:host-gateway` is added on Linux in
normal mode for cross-platform host addressing.

## Supply-chain controls

The host uses pnpm with:

- committed `pnpm-lock.yaml`;
- a three-day `minimumReleaseAge`;
- an `onlyBuiltDependencies` allowlist for install scripts.

The runner has a separate committed Bun lockfile. Bun has no equivalent
release-age policy, so runtime dependency updates require deliberate review.
The container image pins Bun and global CLI versions in the Dockerfile.

CI installs both trees with frozen lockfiles, typechecks host and runner, runs
host and runner tests plus coverage, and checks formatting.

## Operational guidance

- Keep `.env`, OneCLI state, local handoffs, DB backups, and private skills
  out of the public repository.
- Use `pnpm run backup` before writable maintenance.
- Inspect SQLite with the read-only wrapper documented in [db.md](db.md).
- Rebuild host TypeScript before restarting after `src/` changes.
- Recycle running agent containers after runner-source or mounted-skill
  changes.
- Review additional mounts and direct container secrets as security changes,
  not convenience configuration.
- Treat a provider/tool verification result as scoped to its fingerprint;
  endpoint/model/protocol changes require re-verification.

## Known limits

- Writable agent workspaces allow the model to change its own durable files.
- Sessions in the same agent group intentionally share those files.
- Default Docker networking permits general egress unless lockdown is enabled.
- Containers reduce host exposure but do not protect data deliberately mounted
  into them.
- A tool with external side effects can still make a bad authorized decision;
  isolation and validation do not replace least privilege or human approval.
- Runtime and provider CLIs are substantial dependencies and must be kept
  patched and reviewed.

Security-sensitive implementation changes should include tests at both sides
of the boundary: runner emission and host authorization/delivery.
