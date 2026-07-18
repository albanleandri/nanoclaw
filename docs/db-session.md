# NanoClaw — Per-Session DB Schema

Reference for the two SQLite files each session owns: `inbound.db` (host writes, container reads) and `outbound.db` (container writes, host reads). Start with [db.md](db.md) for the three-DB overview, the single-writer rule, and the cross-mount visibility constraints.

Schemas live in `src/db/schema.ts` as the `INBOUND_SCHEMA` and `OUTBOUND_SCHEMA` constants. Both files are created by `ensureSchema()` in `src/session-manager.ts` when a new session folder is provisioned.

---

## 1. Session folder layout

```
data/v2-sessions/<agent_group_id>/<session_id>/
  inbound.db              ← host writes, container reads (read-only mount)
  outbound.db             ← container writes, host reads (read-only open)
  .heartbeat              ← mtime touched by container (not a DB write)
  inbox/<message_id>/     ← user attachments, decoded from inbound message content
  outbox/<message_id>/    ← attachments the agent produced
```

One session = one folder = one pair of DBs. The `agent_group_id` parent directory also holds per-group state (`.claude-shared/`, `agent-runner-src/`) that is shared across every session of that agent group.

Path helpers in `src/session-manager.ts`: `sessionDir()`, `inboundDbPath()`, `outboundDbPath()`, `heartbeatPath()`.

Although `inbox/` belongs to the session, it is writable by the container.
Before the host stores channel or agent-to-agent attachment bytes, it rejects
symlinks/non-directories at both the inbox root and per-message directory,
checks resolved containment, and uses exclusive file creation/copy semantics.
The shared guard lives in `src/inbox-safety.ts`.

---

## 2. Inbound DB (`inbound.db`)

Host-owned, container-read-only. Schema constant: `INBOUND_SCHEMA` in `src/db/schema.ts`.

### 2.1 `messages_in`

Every message landing in the session: user chat, scheduled task, recurring task, question response, internal system message.

Phase E adds three host-written kinds:

- `agent-task` — a validated assignment in the assignee's dedicated task session;
- `agent-task-event` — a correlated status/result/artifact event in the original requester session;
- `agent-task-cancel` — a durable cancellation notice to the assignee.

Their stable IDs are respectively `agent-task:<taskId>`, `agent-task-event:<taskId>:<eventSeq>`, and `agent-task-cancel:<taskId>`. Retry uses insert-if-absent semantics and rejects an ID reused with different content.

Runtime timestamps are stored as UTC ISO-8601 instants with an explicit `Z`
suffix (for example, `2026-07-18T20:15:30.123Z`). Scheduled inputs may carry an
offset or a local wall-clock value at the API boundary, but they are normalized
before storage. SQL due-time checks wrap stored scheduling values in
`datetime(...)`; code must not compare timestamp strings lexicographically.
Human `ncl` output renders complete UTC instants in the configured local
timezone, while `ncl --json` preserves the stored ISO value.

```sql
CREATE TABLE messages_in (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,           -- EVEN only (host assigns) — see §3
  kind           TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',   -- pending|processing|completed|failed|paused
  process_after  TEXT,
  recurrence     TEXT,                     -- cron expr for recurring
  series_id      TEXT,                     -- groups occurrences of a recurring task
  tries          INTEGER DEFAULT 0,
  trigger        INTEGER NOT NULL DEFAULT 1, -- 0 = context only (don't wake), 1 = wake agent
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL,            -- JSON; shape depends on kind
  source_session_id TEXT,                  -- agent-to-agent return path
  orchestration_run_id TEXT,               -- central run correlation; NULL otherwise
  on_wake        INTEGER NOT NULL DEFAULT 0 -- 1 = only deliver on container's first poll
);
CREATE INDEX idx_messages_in_series ON messages_in(series_id);
```

Content shapes: see [api-details.md §Session DB Schema Details](api-details.md#session-db-schema-details).

**Writers (host):** `insertMessage()`, `insertTask()`, `insertRecurrence()` — all in `src/db/session-db.ts`. Each calls `nextEvenSeq()`.
**Reader (container):** `container/agent-runner/src/db/messages-in.ts` — polls `status='pending' AND (process_after IS NULL OR process_after <= now)`.

### 2.2 `delivered`

Host writes here after handing a `messages_out` row to the channel adapter. Container reads `platform_message_id` to target edits and reactions.

```sql
CREATE TABLE delivered (
  message_out_id      TEXT PRIMARY KEY,
  platform_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'delivered',  -- delivered|failed
  delivered_at        TEXT NOT NULL
);
```

Writer: `markDelivered()` / `markDeliveryFailed()` in `src/db/session-db.ts`. Older session DBs are brought up to schema lazily by `migrateDeliveredTable()`.

### 2.3 `destinations`

Projection of the central `agent_destinations` table (see [db-central.md §1.10](db-central.md#110-agent_destinations)) for this session's agent. The container resolves `to="name"` against this table; if the row is absent, the send is rejected as `unknown destination`.

```sql
CREATE TABLE destinations (
  name           TEXT PRIMARY KEY,
  display_name   TEXT,
  type           TEXT NOT NULL,   -- 'channel' | 'agent'
  channel_type   TEXT,            -- for type='channel'
  platform_id    TEXT,            -- for type='channel'
  agent_group_id TEXT             -- for type='agent'
);
```

Rewritten wholesale (DELETE + INSERT in a transaction) by `writeDestinations()` on every container wake and on demand when wiring changes mid-session. The comment on the table in `src/db/schema.ts` is the canonical statement of the refresh semantics.

### 2.4 `session_routing`

Single-row (`id=1`) default routing: where outbound messages go when the agent doesn't specify a destination.

```sql
CREATE TABLE session_routing (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  channel_type TEXT,
  platform_id  TEXT,
  thread_id    TEXT
);
```

Written by `writeSessionRouting()` on every container wake, derived from `sessions.messaging_group_id` + `sessions.thread_id`.

---

## 3. Sequence numbering invariant

Every message gets an integer `seq` from a direction-specific parity lane. The
lanes prevent the same value from being allocated in both tables, but they are
not a globally monotonic clock across two independent SQLite files.

- **Host writes even seq** (2, 4, 6, …), normally to `messages_in` via
  `nextEvenSeq()`. The stopped-container control-ack path may write an even
  row to `messages_out`.
- **Runner writes odd seq** (1, 3, 5, …) to `messages_out`. Its allocator
  observes `MAX(seq)` in both tables before selecting the next odd value.

Why disjoint? `seq` is the agent-facing message ID. When the agent calls
`edit_message(seq=5)` or `add_reaction(seq=6)`, lookup checks both tables.
Parity guarantees that at most one direction owns a value. Collisions would
break editing.

Do not sort a union of both tables by `seq` and treat it as exact chronology.
Host inbound allocation does not lock or read the runner-owned DB. If you add
a write path, preserve actor parity; the cross-table invariant is enforced by
the allocators, not a shared database constraint.

---

## 4. Outbound DB (`outbound.db`)

Container-owned, host reads only. Schema constant: `OUTBOUND_SCHEMA` in `src/db/schema.ts`.

### 4.1 `messages_out`

Everything the agent produces: chat replies, edits, reactions, cards, question sends, agent-to-agent messages, system actions.

```sql
CREATE TABLE messages_out (
  id            TEXT PRIMARY KEY,
  seq           INTEGER UNIQUE,   -- odd runner rows; even stopped-host control rows
  in_reply_to   TEXT,
  timestamp     TEXT NOT NULL,
  deliver_after TEXT,
  recurrence    TEXT,
  kind          TEXT NOT NULL,    -- chat|chat-sdk|system|…
  platform_id   TEXT,
  channel_type  TEXT,
  thread_id     TEXT,
  content       TEXT NOT NULL     -- JSON; operation lives inside (edit/reaction/card/…)
);
```

Content shapes: see [api-details.md §Session DB Schema Details](api-details.md#session-db-schema-details).

**Writers:** runner `writeMessageOut()` normally; host
`writeOutboundDirect()` only while the container is confirmed stopped.
**Readers (host):** `src/delivery.ts` (polling delivery), `getMessageIdBySeq()` / `getRoutingBySeq()` for edit/reaction targeting.

### 4.2 `processing_ack`

Container-side status for each `messages_in.id` it has touched. The host polls this and syncs status back into `messages_in` — this avoids the container ever writing to `inbound.db`.

```sql
CREATE TABLE processing_ack (
  message_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL,      -- processing|completed|failed
  status_changed TEXT NOT NULL
);
```

Crash recovery: on container startup, stale `processing` entries get cleared. Host-side sync: `syncProcessingAcks()` in `src/host-sweep.ts`.
Terminal acknowledgements retain their outcome when reconciled:
`completed` becomes `messages_in.status = 'completed'`, while `failed` becomes
`messages_in.status = 'failed'`.

Follow-up messages that arrive while a provider query is active move to
`processing` when the poll loop pushes them into the active query. They move to
`completed` only after the provider acknowledges that the follow-up turn
produced a result. This distinction is important: accepting or queueing a
follow-up is not enough to complete the inbound row, because a provider can
drop or no-op a late push.

### 4.3 `session_state`

Persistent container-owned KV store. Provider continuations and bounded
provider transcript state are keyed by runtime/profile identity here so a
conversation can resume across container restarts. The selected provider's
state is cleared by `/clear`.

```sql
CREATE TABLE session_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Access: `container/agent-runner/src/db/session-state.ts`.

### 4.4 `container_state`

Single-row runner liveness detail for a tool currently in flight:

```sql
CREATE TABLE container_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  current_tool             TEXT,
  tool_declared_timeout_ms INTEGER,
  tool_started_at          TEXT,
  updated_at               TEXT NOT NULL
);
```

The runner updates this around tool execution. Host sweep reads it to avoid
declaring a container stuck before a user-declared Bash timeout has elapsed.
It is advisory liveness state, not a durable job record.

### 4.5 Host-mediated session search

The runner writes a `system` outbound row with `action: "session_search"` and
a stable `requestId`. The host derives the source agent group, queries the
central FTS5 projection, and inserts a trigger-0 `system` response into
`inbound.db`. The MCP handler reads and acknowledges that response through
`processing_ack`. Search text and results never require a central DB mount or
another writer for either session DB.

### 4.6 Orchestration terminal metadata

For inbound rows carrying a non-null `orchestration_run_id`, the runner writes
a `system` outbound row with `action: "orchestration_result"`. Correlation
metadata is separate from the adapter-provided message ID, so routing and
delivery IDs retain their existing shape. The action contains only the scoped
inbound IDs, terminal outcome, normalized provider usage when available,
timestamp, and stable event ID. Prompt text, model output, tool arguments, and
files are not duplicated into the orchestration event.

The terminal action is written at the provider turn boundary and before any
user-facing result/error row. Provider streams may intentionally remain open
for follow-up turns, so orchestration completion must not wait for stream
shutdown. The host processes outbound rows in sequence and can authorize the
following correlated reply in the same delivery drain.

While processing a batch, runner-written outbound rows default
`in_reply_to` to the first inbound message ID unless the caller supplies a
more specific correlation. This includes host system actions, allowing the
host to derive orchestration identity without trusting action content.

The host derives the source session, updates the correlated central model-step
attempt idempotently, and marks user-facing delivery separately from the
normal outbound row's `in_reply_to`. Delivery waits while the model attempt is
active and is suppressed after cancellation.

An approved fallback does not rewrite the source session's provider state.
The host creates a deterministic fallback session with its own `inbound.db`
and `outbound.db`, copies only the reconstructable correlated input, and binds
that session to the new central step attempt. The copied row retains the same
`orchestration_run_id`; central `execution_session_id` ownership ensures that
primary-session terminal output cannot complete the fallback attempt.

---

## 5. Schema evolution

Unlike the central DB, session DBs do **not** go through numbered migrations. Both `INBOUND_SCHEMA` and `OUTBOUND_SCHEMA` use `CREATE TABLE IF NOT EXISTS`, so a fresh session always gets the current shape. For session folders created under older builds, column-level gaps are patched lazily on open — e.g. `migrateDeliveredTable()` in `src/db/session-db.ts` adds `platform_message_id` and `status` to the `delivered` table if missing.

If you add a column to either schema, add a matching lazy migration for existing session folders, and prefer nullable columns or defaulted values so no data backfill is required.
