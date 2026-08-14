# NanoClaw — Central DB Schema

Complete reference for `data/v2.db`, the host-owned admin-plane database. Start with [db.md](db.md) for the three-DB overview, the map, and the cross-mount rules.

Access layer: `src/db/`. Authoritative schema reference: `src/db/schema.ts` (comments only — actual creation runs via migrations in `src/db/migrations/`).

---

## 1. Tables

### 1.1 `agent_groups`

Agent workspaces. Each maps 1:1 to a `groups/<folder>/` directory containing
provider-native generated docs, skills, and memory/work files. Container
configuration lives in `container_configs` (see §1.15). The host writes a
group-level `container.json` operator snapshot and a separate effective
per-session `container.runtime.json`.

```sql
CREATE TABLE agent_groups (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  folder           TEXT NOT NULL UNIQUE,
  agent_provider   TEXT,
  created_at       TEXT NOT NULL
);
```

- **Readers:** `src/session-manager.ts`, `src/delivery.ts`, `src/router.ts`
- **Writers:** `src/db/agent-groups.ts`

### 1.2 `messaging_groups`

One row per platform chat (one WhatsApp group, one Slack channel, one 1:1 DM, etc.).

```sql
CREATE TABLE messaging_groups (
  id                    TEXT PRIMARY KEY,
  channel_type          TEXT NOT NULL,
  platform_id           TEXT NOT NULL,
  name                  TEXT,
  is_group              INTEGER DEFAULT 0,
  unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
  created_at            TEXT NOT NULL,
  UNIQUE(channel_type, platform_id)
);
```

- `unknown_sender_policy`: `strict` (drop), `request_approval` (ask admin), `public` (allow).
- **Readers:** `src/router.ts`, `src/delivery.ts`, `src/session-manager.ts`
- **Writers:** `src/db/messaging-groups.ts`, channel setup flows

### 1.3 `messaging_group_agents`

Wiring: which agent group handles which messaging group. Many-to-many — the same channel can route to multiple agents (see [isolation-model.md](isolation-model.md)).

```sql
CREATE TABLE messaging_group_agents (
  id                     TEXT PRIMARY KEY,
  messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
  engage_mode            TEXT NOT NULL DEFAULT 'mention',
  engage_pattern         TEXT,
  sender_scope           TEXT NOT NULL DEFAULT 'all',
  ignored_message_policy TEXT NOT NULL DEFAULT 'drop',
  session_mode           TEXT DEFAULT 'shared',
  priority               INTEGER DEFAULT 0,
  created_at             TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);
```

- `session_mode`: `shared` (one session per channel), `per-thread` (one per thread), `agent-shared` (one per agent group across all channels).
- `engage_mode`: `pattern`, `mention`, or `mention-sticky`.
- `engage_pattern`: required regex for `pattern`; `.` means match every
  message.
- `sender_scope`: `all` or `known`.
- `ignored_message_policy`: `drop` or `accumulate` as trigger-0 context.
- **Side effect:** creating a wiring must also populate `agent_destinations` — don't mutate one without the other (see §1.10).

### 1.4 `users`

Platform user identities. ID is namespaced: `tg:123456`, `discord:abc`, `phone:+1555...`, `email:a@x.com`. One human may own several rows — no cross-channel linking yet.

```sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  display_name TEXT,
  created_at   TEXT NOT NULL
);
```

- **Writers/readers:** `src/db/users.ts`; channel auth flows

### 1.5 `user_roles`

Permissions. **Privilege is user-level, never agent-group-level.**

```sql
CREATE TABLE user_roles (
  user_id        TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL,
  agent_group_id TEXT REFERENCES agent_groups(id),
  granted_by     TEXT REFERENCES users(id),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
CREATE INDEX idx_user_roles_scope ON user_roles(agent_group_id, role);
CREATE UNIQUE INDEX idx_user_roles_global_unique
  ON user_roles(user_id, role) WHERE agent_group_id IS NULL;
```

Invariants:

- `role = 'owner'` → must be global (`agent_group_id IS NULL`). Enforced in `grantRole()`.
- `role = 'admin'` → global (NULL) or scoped to one agent group.
- Global grants are unique per `(user_id, role)`. The partial unique index is
  required because SQLite permits duplicate NULL values in the composite
  primary key.
- Admin @ A implies membership in A — no `agent_group_members` row required.

Access layer: `src/modules/permissions/db/user-roles.ts`,
`src/modules/permissions/access.ts`.

### 1.6 `agent_group_members`

Explicit membership for non-privileged users. Owner and admins don't need rows here — they're implicit members.

```sql
CREATE TABLE agent_group_members (
  user_id        TEXT NOT NULL REFERENCES users(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  added_by       TEXT REFERENCES users(id),
  added_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);
```

### 1.7 `user_dms`

Cache of DM channel discovery. Lets the host send a cold DM (approval card, pairing code) without hitting the platform's `openConversation` API every time.

```sql
CREATE TABLE user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);
```

Populated lazily by `ensureUserDm()` in
`src/modules/permissions/user-dm.ts`. Ordinary resolution logs are
data-minimized: they may retain the channel type but omit user identities,
handles, messaging-group/platform identifiers, and raw adapter errors.

### 1.8 `sessions`

Session registry. One row per (agent group, messaging group, thread) tuple subject to `session_mode`. Stores lifecycle metadata only — no messages.

```sql
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  messaging_group_id TEXT REFERENCES messaging_groups(id),
  thread_id          TEXT,
  agent_provider     TEXT,
  provider_profile_id TEXT REFERENCES provider_profiles(id) ON DELETE SET NULL,
  status             TEXT DEFAULT 'active',
  container_status   TEXT DEFAULT 'stopped',
  last_active        TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX idx_sessions_lookup     ON sessions(messaging_group_id, thread_id);
```

- **Resolved by:** `resolveSession()` in `src/session-manager.ts`.
- Creating a session also provisions the session folder and both session DBs via `initSessionFolder()` — see [db-session.md](db-session.md).

### 1.8a `agent_group_memory_control`

Group-scoped control-plane state for provider-neutral memory rollout,
single-writer ownership, and maintenance fencing. Migration 033 backfills one
`disabled/none` row per existing group, and an `agent_groups` insert trigger
creates the same default transactionally for every future insertion path.

```sql
CREATE TABLE agent_group_memory_control (
  agent_group_id          TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
  mode                    TEXT NOT NULL, -- disabled | shadow | active
  migration_state         TEXT NOT NULL, -- none | staging | validated | migrated
  writer_session_id       TEXT REFERENCES sessions(id) ON DELETE RESTRICT,
  maintenance_fence_owner TEXT,
  maintenance_fence_token TEXT,
  maintenance_fenced_at   TEXT,
  version                 INTEGER NOT NULL,
  last_transition_at      TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
```

The table constrains legal mode/state combinations, requires a writer in
`active/migrated`, and uses triggers to require the writer session to belong
to the same agent group. Fence owner/token/time are either all null or all
present. State transitions use optimistic `version` matching.

The container wake path checks a non-null fence token before reserving
capacity and immediately before process spawn. A held wake leaves work
pending and returns `maintenance-held`.

Access layer: `src/db/agent-group-memory-control.ts`.

### 1.9 `pending_questions`

The `ask_user_question` MCP tool parks an interactive question here, and the container matches incoming `system` messages back to it by `questionId`.

```sql
CREATE TABLE pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  message_out_id TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  title          TEXT NOT NULL,
  options_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
```

### 1.10 `agent_destinations`

Permission ACL _and_ name-resolution map for outbound sending. An agent asking to `send_message(to="dev-channel")` must have a row here with `local_name = 'dev-channel'`, or the send is rejected as `unknown destination`.

```sql
CREATE TABLE agent_destinations (
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  local_name     TEXT NOT NULL,
  target_type    TEXT NOT NULL,   -- 'channel' | 'agent'
  target_id      TEXT NOT NULL,   -- messaging_group_id | agent_group_id
  created_at     TEXT NOT NULL,
  PRIMARY KEY (agent_group_id, local_name)
);
CREATE INDEX idx_agent_dest_target ON agent_destinations(target_type, target_id);
```

**Projection invariant (load-bearing).** The central table is the source of truth, but each running container reads from a projection in its own `inbound.db` (see [db-session.md §2.3](db-session.md#23-destinations)). Any code that mutates `agent_destinations` while a container is running must also call `writeDestinations()` (`src/session-manager.ts`) or the container will reject sends with stale data. Known call sites: `createMessagingGroupAgent()` in `src/db/messaging-groups.ts`, the `create_agent` system action in `src/delivery.ts`.

Access layer: `src/db/agent-destinations.ts`.

### 1.11 `pending_approvals`

Two workflows share this table:

- **Session-bound MCP approvals** — `install_packages`, `add_mcp_server`. `session_id` is set.
- **OneCLI credential approvals** — `session_id` may be NULL; `agent_group_id` + `channel_type` + `platform_id` route the admin card.

```sql
CREATE TABLE pending_approvals (
  approval_id         TEXT PRIMARY KEY,
  session_id          TEXT REFERENCES sessions(id),
  request_id          TEXT NOT NULL,
  action              TEXT NOT NULL,
  payload             TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  agent_group_id      TEXT REFERENCES agent_groups(id),
  channel_type        TEXT,
  platform_id         TEXT,
  platform_message_id TEXT,
  expires_at          TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',
  title               TEXT NOT NULL DEFAULT '',
  options_json        TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_pending_approvals_action_status ON pending_approvals(action, status);
```

- `status`: `pending` | `approved` | `rejected` | `expired`.
- `platform_message_id` lets the host edit the admin card in place after a decision.
- Approval state is persisted before the card is delivered. Delivery failure removes
  the row, and resolution atomically changes `pending` to a terminal status before
  invoking an action handler, so concurrent responses cannot apply an action twice.
- Access layer: `src/db/sessions.ts`; sweep + delivery:
  `src/modules/approvals/onecli-approvals.ts`.

### 1.12 `unregistered_senders`

Audit trail: every time a message gets dropped (unknown sender, strict policy), we increment a counter here so admins can see who's been trying to knock.

```sql
CREATE TABLE unregistered_senders (
  channel_type       TEXT NOT NULL,
  platform_id        TEXT NOT NULL,
  user_id            TEXT,
  sender_name        TEXT,
  reason             TEXT NOT NULL,
  messaging_group_id TEXT,
  agent_group_id     TEXT,
  message_count      INTEGER NOT NULL DEFAULT 1,
  first_seen         TEXT NOT NULL,
  last_seen          TEXT NOT NULL,
  PRIMARY KEY (channel_type, platform_id)
);
CREATE INDEX idx_unregistered_senders_last_seen ON unregistered_senders(last_seen);
```

Writer: `recordDroppedMessage()` in `src/db/dropped-messages.ts`. On conflict, bumps `message_count` + `last_seen`.

### 1.13 Chat SDK bridge tables

State backing the `SqliteStateAdapter` used by the Chat SDK bridge (see [api-details.md](api-details.md)). NanoClaw code rarely touches these directly — they're owned by `src/state-sqlite.ts`.

```sql
CREATE TABLE chat_sdk_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER                    -- unix ts, nullable
);

CREATE TABLE chat_sdk_subscriptions (
  thread_id     TEXT PRIMARY KEY,
  subscribed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE chat_sdk_locks (
  thread_id  TEXT PRIMARY KEY,
  token      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE chat_sdk_lists (
  key        TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  value      TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (key, idx)
);
```

### 1.14 `schema_version`

Migration ledger, written by the migration runner (§2).

```sql
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  applied TEXT NOT NULL
);
```

### 1.15 `container_configs`

Per-agent-group container runtime config. Source of truth for provider, model, packages, MCP servers, mounts, CLI scope, shared resources, etc. Materialized to `groups/<folder>/container.json` at spawn time. The host also derives a provider-neutral `agentProfile` from this row plus `agent_groups` and embeds it in the materialized JSON for runtime introspection.

```sql
CREATE TABLE container_configs (
  agent_group_id         TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
  provider_profile_id    TEXT REFERENCES provider_profiles(id) ON DELETE SET NULL,
  provider               TEXT,
  model                  TEXT,
  effort                 TEXT,
  image_tag              TEXT,
  assistant_name         TEXT,
  max_messages_per_prompt INTEGER,
  skills                 TEXT NOT NULL DEFAULT '"all"',
  mcp_servers            TEXT NOT NULL DEFAULT '{}',
  packages_apt           TEXT NOT NULL DEFAULT '[]',
  packages_npm           TEXT NOT NULL DEFAULT '[]',
  additional_mounts      TEXT NOT NULL DEFAULT '[]',
  cli_scope              TEXT NOT NULL DEFAULT 'group',   -- disabled | group | global
  shared_resources       TEXT NOT NULL DEFAULT '[]',
  updated_at             TEXT NOT NULL
);
```

`provider_profile_id` is nullable and references `provider_profiles`. It takes precedence over the legacy `provider` string when the host resolves a session runtime.

- **Readers:** `src/container-config.ts`, `src/container-runner.ts`, `src/cli/dispatch.ts`, provider-native composers
- **Writers:** `src/db/container-configs.ts`, setup/CLI, self-mod, backfill

### 1.16 `shared_resource_control`

Ownership and reconciliation state for shared resources. Grants remain in
`container_configs.shared_resources`; this table does not replace or imply a
grant.

```sql
CREATE TABLE shared_resource_control (
  resource_name                TEXT PRIMARY KEY,
  owner_agent_group_id         TEXT REFERENCES agent_groups(id),
  reconciliation_state         TEXT NOT NULL, -- pilot | reconciling | validated | reconciled
  classification_report_path   TEXT,
  classification_report_sha256 TEXT,
  validation_report_json       TEXT,
  approved_at                  TEXT,
  version                      INTEGER NOT NULL DEFAULT 1,
  updated_at                   TEXT NOT NULL
);
```

Absent/pilot control and all non-owner grants are mounted read-only. Only the
explicit owner of a reconciled resource receives a writable resource mount.
The whole `groups/shared` root is never mounted into an agent container.

### 1.17 `provider_profiles`

Local instances of installed provider descriptors. They contain endpoint/model selectors and a OneCLI secret reference, never a raw credential. See [providers.md](providers.md).

Key columns are `provider_name`, `protocol`, `base_url`, `api_family`, `tool_strategy`, `tool_verified_at`, `tool_verification_fingerprint`, `default_model`, `auth_mode`, `auth_ref`, `capability_overrides`, and `enabled`.

Migration 021 adds the nullable tool-verification fields. `tool_strategy=native`
is valid only when the stored non-secret endpoint/model fingerprint still
matches the profile.

- **Readers/writers:** `src/db/provider-profiles.ts`, provider CLI/setup, `src/providers/effective-provider.ts`

### 1.18 `schedule_admin_grants`

Authorizes one agent group to administer task rows that remain owned by another group's session DB:

```sql
CREATE TABLE schedule_admin_grants (
  admin_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
  owner_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  created_by TEXT,
  PRIMARY KEY (admin_agent_group_id, owner_agent_group_id)
);
```

Recurring task rows are never duplicated into the administrator's session.

- **Readers/writers:** `src/db/schedule-admin-grants.ts`, scheduling actions,
  CLI

### 1.19 `jobs`, `job_events`, and `agent_tasks`

`jobs` and `job_events` remain the shared durable lifecycle/event backbone. Migration 022 adds `agent_tasks`, a narrow ownership and correlation relation for `jobs.type='agent_task'`.

The channel/platform fields on `jobs` are delivery state, not authority. Job
actions persist only a host-resolved messaging-group route authorized for the
source session, and the delivery poll revalidates that relationship before
sending each progress or terminal event. Rows without a valid source session
or currently authorized route remain pending.

Key `agent_tasks` columns are `job_id`, requester/assignee agent group and session IDs, optional `parent_task_id`, discriminated `scope`, reserved plan-role correlation fields, and stable dispatch/cancel message IDs. Requester and assignee indexes support actor-scoped lookup. The complete validated `AgentTaskEnvelope` remains in `jobs.params_json`.

Task state is monotonic (`queued → running → succeeded|failed|cancelled`), events have per-job sequence numbers, and stable action/message IDs make host delivery retries idempotent. `scope='agent-delegation'` is executable; `scope='plan-role'` is schema-reserved.

- **Readers/writers:** `src/db/agent-tasks.ts`, `src/jobs/agent-task-service.ts`, `src/jobs/agent-task-actions.ts`

### 1.20 Auxiliary routing and session search

Migration 023 adds `auxiliary_routes` and `auxiliary_invocations`.
`auxiliary_routes` is keyed by agent group and typed role and enforces the
nullable columns for `main`, `endpoint-profile`, `agent`, and `disabled`
targets. `auxiliary_invocations` relates a `jobs.type='auxiliary_invocation'`
row to its resolved target/runtime, optional isolated session, and normalized
usage. Note: the route **config** surface (`ncl auxiliary-routes`) is live, but
the invocation **execution** path (`executeAuxiliaryInvocation` in
`src/auxiliary/service.ts`) is staged scaffolding with no production caller yet.
Its trust boundary is enforced by the function's shape rather than by call-site
discipline: `AuxiliaryInvocationInput` carries no source identity and no target,
so `sourceAgentGroupId`/`sourceSessionId` can only be stamped from the trusted
session and the target can only come from this table's configured route for that
session's group and role.

Migration 024 adds `session_search_documents` plus the external-content
`session_search_fts` FTS5 table and synchronization triggers. Documents are
uniquely keyed by `(session_id, source_kind, message_id)`, scoped by
`agent_group_id`, source-attributed, and deleted with their source
session/group.

- **Readers/writers:** `src/auxiliary/`, `src/db/auxiliary-*.ts`,
  `src/session-search/`

### 1.21 Skill provenance and capability audit

Migration 025 adds `skill_installations` and append-only
`skill_provenance_events`. An installation records the effective skill source,
manifest version, approved and observed content hashes, approval actor/time,
and one of `active`, `drifted`, `quarantined`, or `disabled`. Content is
re-hashed before activation and approval; startup never approves a new hash.

Migration 026 adds append-only `capability_audit_events`, keyed by stable event
ID with a unique `(invocation_id, seq)`. Rows contain source-derived
agent/session identity, runtime and capability identity, adapter/entrypoint,
redacted argument hash, decision/result classification, duration, normalized
usage, and timestamp. Raw arguments/results are intentionally absent. Reads
must remain agent-group scoped; no automatic destructive retention job is
installed.

- **Readers/writers:** `src/skills/`, `src/db/skill-provenance.ts`,
  `src/audit/`, skill/audit CLI resources

### 1.22 Orchestration runs

Migration 027 adds `orchestration_runs`, `orchestration_step_attempts`, and
append-only `orchestration_events`. The run stores the validated versioned
plan, pattern/policy identity, source agent/session, status, and normalized
usage. Attempts store step/role/kind, stable idempotency key, correlated
inbound message ID, terminal classification, usage attribution, and timing.

The first executable pattern is `direct@1`: one existing-session model step
followed by one user-facing delivery step. Runs are created before the session
message is written. Runner terminal metadata completes the model attempt;
successful or permanently failed outbound delivery completes the delivery
attempt. There is no automatic destructive retention job.

- **Readers/writers:** `src/orchestration/`, router, container runner,
  delivery, runner poll loop, orchestration CLI resource

Migration 028 adds cancellation metadata to runs; lease, batch, and timeout
metadata to attempts; and `orchestration_session_authorizations`, which stores
the last compiled capability IDs for a session. It also links capability audit
events to a source-derived orchestration run. The host sweep terminally
recovers expired leases and wall-clock budgets. Cancellation is durable and
idempotent; adapter cancellation is requested only for an isolated processing
claim so a shared batch is not killed accidentally.

Migration 029 adds per-attempt runtime/protocol/continuation identity,
capability and tool-contract fingerprints, input reconstructability,
tri-state side-effect-boundary state, result/artifact/delivery facts, and
retryability. `orchestration_fallback_decisions` stores the evaluated
candidate, policy version, allow/deny result, and all rejection reasons before
an approved next attempt can be queued. The policy remains default-off.

Migration 030 adds `orchestration_step_attempts.execution_session_id`.
Initial model attempts are backfilled to the run's source session; an approved
fallback attempt is bound to its deterministic provider-profile session before
dispatch. Result, delivery, authorization, cancellation, and active-capability
lookups use this execution owner rather than assuming every attempt runs in
the source session.

---

## 2. Migration system

Migrations live in `src/db/migrations/`, one file per migration. Runner: `runMigrations()` in `src/db/migrations/index.ts`. It:

1. Creates `schema_version` if absent (with a unique index on `name`).
2. Reads the set of already-applied migration **`name`s** from `schema_version`.
3. For each migration in the barrel array whose `name` is not yet applied, executes `up(db)` inside a transaction and appends a `schema_version` row. The stored `version` column is an auto-assigned applied-order counter (`MAX(version)+1`), **not** the `version` field on the migration object — uniqueness is keyed on `name`, so module migrations added by install skills can pick arbitrary version numbers without coordinating.

| #   | File                                      | Introduces                                                                                                                                                           |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 001 | `001-initial.ts`                          | Core tables: `agent_groups`, `messaging_groups`, `messaging_group_agents`, `users`, `user_roles`, `agent_group_members`, `user_dms`, `sessions`, `pending_questions` |
| 002 | `002-chat-sdk-state.ts`                   | `chat_sdk_kv`, `chat_sdk_subscriptions`, `chat_sdk_locks`, `chat_sdk_lists`                                                                                          |
| mod | `module-approvals-pending-approvals.ts`   | `pending_approvals` (session-bound + OneCLI fields). Name-keyed module migration (`name: pending-approvals`), applied after 002.                                     |
| mod | `module-agent-to-agent-destinations.ts`   | `agent_destinations` + backfill from existing `messaging_group_agents` wirings (`name: agent-destinations`)                                                          |
| mod | `module-approvals-title-options.ts`       | `ALTER TABLE pending_approvals` add `title`, `options_json` (`name: pending-approvals-title-options`)                                                                |
| 008 | `008-dropped-messages.ts`                 | `unregistered_senders`                                                                                                                                               |
| 009 | `009-drop-pending-credentials.ts`         | Drop the defunct `pending_credentials` table                                                                                                                         |
| 010 | `010-engage-modes.ts`                     | Wiring engagement and ignored-message policy fields                                                                                                                  |
| 011 | `011-pending-sender-approvals.ts`         | Pending unknown-sender approval state                                                                                                                                |
| 012 | `012-channel-registration.ts`             | Unknown-channel registration approval state and durable deny timestamp                                                                                               |
| 013 | `013-approval-render-metadata.ts`         | Approval rendering metadata                                                                                                                                          |
| 014 | `014-container-configs.ts`                | `container_configs` — per-agent-group container runtime config                                                                                                       |
| 015 | `015-cli-scope.ts`                        | `ALTER TABLE container_configs ADD COLUMN cli_scope`                                                                                                                 |
| 016 | `016-durable-jobs.ts`                     | Durable job and job-event state                                                                                                                                      |
| 017 | `017-screen-market-guided.ts`             | Guided stock-screen module state                                                                                                                                     |
| 018 | `018-shared-resources.ts`                 | Shared-resource catalog and per-group grants                                                                                                                         |
| 019 | `019-provider-profiles.ts`                | Provider profiles plus nullable group/session profile references                                                                                                     |
| 020 | `020-schedule-admin-grants.ts`            | Generic schedule owner/admin grants                                                                                                                                  |
| 021 | `021-provider-tool-verification.ts`       | Provider-profile tool verification state                                                                                                                             |
| 022 | `022-agent-tasks.ts`                      | Durable cross-agent task ownership and correlation                                                                                                                   |
| 023 | `023-auxiliary-routing.ts`                | Typed auxiliary routes and durable invocation relation                                                                                                               |
| 024 | `024-session-search.ts`                   | Scoped session text metadata and FTS5 projection                                                                                                                     |
| 025 | `025-skill-provenance.ts`                 | Effective skill approval, observed hashes, drift state, and provenance events                                                                                        |
| 026 | `026-capability-audit.ts`                 | Redacted append-only canonical capability lifecycle events                                                                                                           |
| 027 | `027-orchestration-runs.ts`               | Versioned execution plans, durable step attempts, normalized usage, and append-only run events                                                                       |
| 028 | `028-orchestration-lifecycle.ts`          | Attempt leases, cancellation, session authorization snapshots, and capability-audit correlation                                                                      |
| 029 | `029-orchestration-fallback.ts`           | Durable fallback compatibility/side-effect facts and append-only candidate decisions                                                                                 |
| 030 | `030-orchestration-execution-sessions.ts` | Per-attempt execution-session ownership for isolated fallback dispatch and result correlation                                                                        |
| 031 | `031-capability-audit-tenant-scope.ts`    | Rebuild `capability_audit_events` with `UNIQUE(agent_group_id, invocation_id, seq)` so invocation chains are isolated per agent group                                |
| 032 | `032-user-role-global-uniqueness.ts`      | Deduplicate legacy global role grants and enforce one `(user_id, role, NULL)` row with a partial unique index                                                        |
| 033 | `033-agent-group-memory-control.ts`       | Group-scoped neutral-memory mode, migration state, designated writer, maintenance fence, and default-row trigger                                                     |
| 034 | `034-shared-resource-control.ts`          | Shared-resource reconciliation state and approved writer-owner control                                                                                               |

Numbered files jump 002 → 008: the early `pending_approvals` / `agent_destinations` / title-options migrations were refactored into the three name-keyed `module-*` migrations listed above, and no `003`–`007` numbered files exist. Because the runner keys on `name` (not the numeric `version`), the gap is cosmetic.

Session DB schemas (`INBOUND_SCHEMA`, `OUTBOUND_SCHEMA`) are **not** versioned here. They're `CREATE TABLE IF NOT EXISTS` so new columns land via the session-DB lazy migration helpers (`migrateDeliveredTable()` etc.) when a session file from an older build is reopened. See [db-session.md](db-session.md).
