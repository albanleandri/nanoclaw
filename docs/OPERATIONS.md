# Operations

Canonical operational commands for both Codex and Claude Code live here.
Run them from the repository root. The host uses Node + pnpm; the container
runner uses Bun.

## Optional private broker portfolio synchronization

This checkout may provide a private `stock-market-investing` extension with a
credentialed gateway and separate network-denied importer. It is not part of
the NanoClaw host or Bun agent-runner. When present, follow
`container/skills/custom/stock-market-investing/references/ibkr-private-sync-operations.md`.
Do not improvise a same-user or agent-container fallback. An authorized agent
may receive only the exact sanitized `portfolio-sync.db` file read-only.

## Build

```bash
pnpm run build
./container/build.sh
```

## Setup

```bash
pnpm run setup:bootstrap
pnpm run setup:step -- environment
pnpm run setup:step -- timezone -- --tz <your-timezone>
```

## Service

```bash
pnpm run service:status
pnpm run service:restart
```

`service:restart` chooses the best available path in this order:

- `systemctl --user restart nanoclaw`
- `launchctl kickstart -k gui/<uid>/com.nanoclaw`
- `bash start-nanoclaw.sh`

`service:status` checks the best available path in this order:

- `systemctl --user status nanoclaw`
- `launchctl list | grep nanoclaw`
- `ps` lookup of the `start-nanoclaw.sh` fallback process

Host source changes require `pnpm run build` before restart. Agent-runner
source under `container/agent-runner/src/` is bind-mounted into newly spawned
containers; recycle running agent containers to load it. Rebuild the image
only when the Dockerfile, dependencies, global CLIs, or other image contents
change.

RTK changes require both an image rebuild and recycling running agent
containers:

```bash
./container/build.sh
docker run --rm --entrypoint rtk <nanoclaw-image>:latest --version
ncl groups restart --id <group-id>
```

The image build selects the RTK asset from Docker's target architecture,
verifies its pinned SHA-256 digest, and runs `rtk --version` plus `rtk gain`.
Runtime analytics and full-output recovery files persist per agent group under
`data/v2-sessions/<agent-group-id>/.rtk/`. Use `rtk gain` inside an active
agent container when diagnosing adoption; do not treat vendor savings
estimates as measured NanoClaw results.

## Verification

```bash
pnpm run typecheck
pnpm test
pnpm run test:coverage
pnpm run format:check
pnpm run lint

pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd container/agent-runner && bun test
cd container/agent-runner && bun run test:coverage
```

## Runtime Guardrails

- Keep the Claude agent-runner path on `@anthropic-ai/claude-agent-sdk`.
- Do not migrate orchestration to OpenAI Agents SDK, LangGraph, or another framework unless explicitly requested.
- Do not add a TypeScript build step to the agent container; Bun executes the
  bind-mounted source directly.

## Neutral-memory writer ownership

Inspect rollout state and effective access without reading memory bodies:

```bash
ncl memory status --agent-group-id <group-id>
ncl memory writer --agent-group-id <group-id>
```

Validate an OKF tree through the isolated, networkless, read-only operator
container. The report contains bounded paths and classifications, never file
bodies. Validation uses the current reviewed base image rather than a
potentially stale group-derived image, because it requires only the
bind-mounted validator source and the base image's native safe-read helper:

```bash
ncl memory validate --agent-group-id <group-id>
ncl memory validate --agent-group-id <group-id> --json
```

For an isolated local rollout rehearsal, the synthetic canary scripts create a
route-less group, promote it only after validation, and add a non-writer
session for mount-boundary checks. They are idempotent and must not be
substituted for the migration workflow of a group containing real data:

```bash
pnpm exec tsx scripts/create-memory-canary.ts
pnpm exec tsx scripts/promote-memory-canary.ts
pnpm exec tsx scripts/add-memory-canary-reader.ts
pnpm exec tsx scripts/send-memory-canary-message.ts --target writer '<probe>'
pnpm exec tsx scripts/send-memory-canary-message.ts --target reader '<probe>'
```

For maintenance workflows, acquire a durable wake/spawn fence and preserve the
returned token. Releasing the fence requires that exact token:

```bash
ncl memory fence --agent-group-id <group-id> --owner <workflow-label>
ncl memory unfence --agent-group-id <group-id> --token <returned-token>
```

Fence and unfence are approval-gated when requested by an agent. A held fence
leaves inbound and scheduled work durable and pending; inspect status before
releasing a fence owned by another workflow.

For an enabled group, exactly one session is the designated writer. Other
sessions receive read-only nested mounts for `memory/` on both workspace
aliases. To transfer ownership, first stop every container in the group, read
the current version/writer from the status command, then run:

```bash
ncl groups memory writer transfer \
  --id <group-id> \
  --writer-session-id <new-session-id> \
  --expected-writer-session-id <current-session-id> \
  --expected-version <version>
```

The transfer is approval-gated for agent callers. It acquires a temporary
durable maintenance fence, drains in-flight wakes, rejects any running/idle
session, verifies the new session belongs to the group, performs an optimistic
compare-and-swap update, and releases the fence. Omit
`--expected-writer-session-id` only when status reports a null current writer.

For a full legacy cutover, use the resumable migration commands instead of
manually composing fences and state transitions:

```bash
ncl memory migrate-prepare --agent-group-id <group-id> \
  --legacy-paths '["CLAUDE.local.md"]'
ncl memory migrate-status --agent-group-id <group-id>
ncl memory migrate-classify --agent-group-id <group-id> \
  --report-path .memory-classification-<workflow-id>.json
ncl memory migrate-validate --agent-group-id <group-id>
ncl memory migrate-approve --agent-group-id <group-id> \
  --workflow-id <workflow-id> --writer-session-id <session-id>
ncl memory migrate-finish --agent-group-id <group-id>
ncl memory migrate-smoke --agent-group-id <group-id> \
  --report-path .memory-smoke-<workflow-id>.json
```

`migrate-prepare` defaults to the explicit `CLAUDE.local.md` manifest; pass
`[]` to stage nothing. Do not place reports below the reserved
`.nanoclaw-memory-migration/` staging tree. Classification JSON contains the
ledger `workflow_id` and an `entries` array. Every staged source must have at
least one `standing-instruction`, `private-memory`, or `omit` entry.
Materialized entries include a safe workspace-relative `destination` and its
`destination_sha256`; private-memory destinations must be below `memory/`.
Omissions include a reason. Recreating a staged source path is allowed only
when a hashed `standing-instruction` entry names that exact path. Approval
rechecks the report and destination hashes, so later edits fail closed. Final
smoke JSON contains the same `workflow_id` and `checks` with boolean `true`
values for `recall`, `correction`, `clear`, `compact`, and `provider-switch`.
The invoking coding harness produces both reports and treats staged bodies as
untrusted data.

Every mutation is approval-gated and rerunnable. Rollback requires the exact
workflow ID:

```bash
ncl memory migrate-rollback --agent-group-id <group-id> \
  --workflow-id <workflow-id>
```

Before approval rollback refuses overwrites and reverses recorded renames.
After approval it reacquires the fence, stops containers, verifies the backup,
retains the current workspace as `*.rollback-displaced-<workflow-id>`,
restores prior workspace/control state, and resumes only recorded series.

## Shared-resource reconciliation

Shared resources are explicit grants. Every resource is read-only until one
owner completes reconciliation; all non-owners remain read-only afterward.
OKF knowledge resources use the isolated OKF validator. Ordinary shared data
directories use bounded structural validation that rejects symlinks, special
files, and inventories larger than 5,000 nodes.

```bash
ncl shared-resources status --name <resource>
ncl shared-resources reconcile-prepare --name <resource> \
  --owner-agent-group-id <group-id>
ncl shared-resources reconcile-validate --name <resource> \
  --report-path data/shared-resource-reconciliation/<resource>/classification.json
ncl shared-resources reconcile-approve --name <resource> \
  --expected-version <validated-version> --confirm <resource>
ncl shared-resources owner-transfer --name <resource> \
  --new-owner-agent-group-id <new-owner-id> \
  --expected-owner-agent-group-id <current-owner-id> \
  --expected-version <current-version> --confirm <resource>
```

The classification report is bounded JSON containing `resource_name`,
`pilot_markers_removed`, and an `entries` array. Every entry supplies `source`
and one of `private-instruction`, `shared-evidence`, or `omit` as
`classification`. Classified entries require `destination`; omitted entries
require `reason`. The coding harness must compare legacy authorities and keep
private group instructions outside the shared bundle. Approval rejects a
changed report or missing pilot-marker attestation. Restart granted groups
after approval so their new per-resource mount modes take effect.
Reconciled ownership can be transferred between already-granted groups without
reclassifying the resource. Transfer remains approval-gated, rechecks the
classification-report hash, requires every granted-group container to be
stopped, and uses current owner plus version as compare-and-swap guards.

The reproducible image-level neutral-memory filesystem smoke mounts an empty
writable directory at `/workspace/agent`, mounts this checkout read-only at
`/repo`, and runs:

```bash
bun /repo/scripts/memory-container-smoke.ts
```

It uses the installed native helper to scaffold in shadow mode, records a
synthetic fact, rerenders and recalls it, corrects it, then verifies the next
render contains only the correction. It contains no live group data or
provider credentials.

## Claude credential reliability

- Set `CLAUDE_ONECLI_SECRET_ID` to the OneCLI secret containing the Claude
  OAuth access token. NanoClaw reconciles the host credential into that secret
  at startup and every five minutes.
- OAuth refresh starts 15 minutes before recorded expiry. This provides at
  least two retry opportunities before expiry and does not require launching
  Claude Code interactively after the initial account authorization.
- A failed refresh never overwrites OneCLI with a known-expired token. Failures
  are logged and retried while the last-known-good vault value is preserved.
- `nanoclaw-refresh-token.timer`, where installed, is only an additional
  recovery mechanism; the running host owns the primary refresh lifecycle.

## Usage-Limit Replies

- If the provider returns a classified quota/auth error, or a recognized bare
  429/401 result, the runner writes a short user-facing notification instead
  of failing silently.
- Authentication notices are limited to one per session per 24 hours. A
  successful provider result clears the cooldown. Late authentication errors
  from an already-completed persistent query are ignored so they cannot be
  correlated to an old user message.
- NanoClaw does not maintain a host-side provider cooldown. Later messages are
  processed normally and may receive another provider error.
