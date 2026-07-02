# NanoClaw Debug Checklist

Run commands from the repository root. See [OPERATIONS.md](OPERATIONS.md) for
the canonical build/test/restart matrix and [db.md](db.md) before inspecting
session databases.

## Quick status

```bash
pnpm run service:status
docker ps --format '{{.Names}} {{.Image}} {{.Status}}'
docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}' | grep nanoclaw-v2
```

Linux systemd logs:

```bash
journalctl --user -u nanoclaw -n 200 --no-pager
journalctl --user -u nanoclaw -f
```

The installed service also appends stdout/stderr to:

```bash
tail -n 200 logs/nanoclaw.log
tail -n 200 logs/nanoclaw.error.log
```

macOS launchd and the fallback launcher use those log files directly.

## Agent did not reply

Follow the durable path in order instead of guessing at provider failure.

### 1. Confirm routing and session creation

Look for router, wake, and spawn events:

```bash
rg 'Inbound|Session created|Spawning container|wakeContainer failed|Container exited' logs/nanoclaw*.log
```

Inspect recent sessions:

```bash
pnpm exec tsx scripts/q.ts --readonly data/v2.db \
  "SELECT id,agent_group_id,messaging_group_id,thread_id,status,container_status,last_active FROM sessions ORDER BY last_active DESC LIMIT 20"
```

Resolve the agent group and messaging wiring when the session is unexpected:

```bash
pnpm exec tsx scripts/q.ts --readonly data/v2.db \
  "SELECT mga.id,mg.channel_type,mg.platform_id,mga.agent_group_id,mga.engage_mode,mga.engage_pattern,mga.ignored_message_policy,mga.session_mode FROM messaging_group_agents mga JOIN messaging_groups mg ON mg.id=mga.messaging_group_id ORDER BY mga.created_at DESC"
```

### 2. Inspect the session queue

Session files are under:

```text
data/v2-sessions/<agent-group-id>/<session-id>/
```

Inbound:

```bash
pnpm exec tsx scripts/q.ts --readonly \
  data/v2-sessions/<agent-group-id>/<session-id>/inbound.db \
  "SELECT id,seq,kind,status,process_after,tries,trigger,orchestration_run_id,timestamp FROM messages_in ORDER BY seq DESC LIMIT 30"
```

Runner acknowledgements and provider state:

```bash
pnpm exec tsx scripts/q.ts --readonly \
  data/v2-sessions/<agent-group-id>/<session-id>/outbound.db \
  "SELECT message_id,status,status_changed FROM processing_ack ORDER BY status_changed DESC LIMIT 30"
```

```bash
pnpm exec tsx scripts/q.ts --readonly \
  data/v2-sessions/<agent-group-id>/<session-id>/outbound.db \
  "SELECT id,current_tool,tool_declared_timeout_ms,tool_started_at,updated_at FROM container_state"
```

Interpretation:

- `messages_in.status=pending`: the host has durable work; check wake/spawn.
- `processing_ack.status=processing`: the runner claimed it; check heartbeat,
  current tool, and container logs.
- completed ack but no output: inspect provider result formatting and system
  actions.

### 3. Inspect runner output and delivery

```bash
pnpm exec tsx scripts/q.ts --readonly \
  data/v2-sessions/<agent-group-id>/<session-id>/outbound.db \
  "SELECT id,seq,in_reply_to,kind,channel_type,platform_id,deliver_after,timestamp,content FROM messages_out ORDER BY seq DESC LIMIT 30"
```

```bash
pnpm exec tsx scripts/q.ts --readonly \
  data/v2-sessions/<agent-group-id>/<session-id>/inbound.db \
  "SELECT message_out_id,platform_message_id,status,delivered_at FROM delivered ORDER BY delivered_at DESC LIMIT 30"
```

Interpretation:

- No `messages_out` row: provider/runner path.
- Outbound row without a `delivered` ledger row: host delivery,
  authorization, adapter, or retry path.
- `delivered.status=failed`: delivery exhausted its bounded retries or output
  was deliberately suppressed.

### 4. Inspect the concrete container

```bash
docker ps --format '{{.Names}} {{.Status}}' | grep nanoclaw-v2
docker logs --tail 200 <container-name>
docker inspect <container-name> --format '{{json .Mounts}}'
```

The expected runtime source mount is
`container/agent-runner/src → /app/src`. The session directory mounts at
`/workspace`; the group workspace mounts at `/workspace/agent` and
`/workspace/group`.

### 5. Inspect orchestration gating

```bash
ncl orchestration-runs list --agent-group-id <agent-group-id>
```

For direct messages, a running model attempt intentionally gates correlated
user-facing delivery. The runner must write an `orchestration_result` system
row before the reply. If the reply exists but the model attempt remains
running, inspect the runner version/container logs and the ordered outbound
rows.

## Provider startup

```bash
ncl providers list
ncl providers profiles
ncl groups config get --id <agent-group-id>
```

For a DB-backed profile:

```bash
ncl providers verify --id <profile-id> --agent-group-id <agent-group-id>
```

Generic OpenAI-compatible profiles remain text-only unless
`providers verify-tools` succeeds and activates the fingerprinted tool
strategy.

Provider-specific checks:

- Claude: inspect runner logs for SDK init/result/error events and verify the
  OneCLI agent credential.
- Codex: inspect app-server JSON-RPC startup, approval, thread, and turn errors
  in runner logs.
- A stale configured skill is omitted with a wake warning; an installed but
  invalid/unapproved manifested skill fails closed.

## Stuck-work and heartbeat checks

```bash
stat data/v2-sessions/<agent-group-id>/<session-id>/.heartbeat
```

Host sweep combines heartbeat age, processing-claim age, pending-message age,
the current tool's declared timeout, and the concrete container's start time.
A fresh container is not killed merely because it picked up old backlog.

Do not “fix” liveness by changing session DBs to WAL or by allowing both host
and container to write the same SQLite file.

## Build/restart matrix

Host `src/` change:

```bash
pnpm run build
pnpm run service:restart
```

Runner `container/agent-runner/src/` change:

```bash
cd container/agent-runner && bun test
```

Runner source is bind-mounted; stop existing agent containers so the next wake
starts a fresh Bun process. No image rebuild is required for source-only
changes.

Image/dependency/Dockerfile change:

```bash
./container/build.sh
pnpm run service:restart
```

## Database safety

Use the read-only query wrapper for inspection:

```bash
pnpm exec tsx scripts/q.ts --readonly <db-path> "<single SELECT/WITH/read-only PRAGMA>"
```

Do not use writable ad-hoc SQLite helpers to “unstick” messages until the
cause is understood. Preserve the one-writer boundary and take a backup before
maintenance:

```bash
pnpm run backup
```
