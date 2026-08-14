# Task-time context and DM-log hardening plan

## Objective

Port two useful upstream fixes into this fork without importing unrelated
upstream behavior:

1. Render scheduled task prompts with both the effective occurrence time and
   the actual runner-formatting time.
2. Prevent cold-DM resolution logs from exposing identities, destination
   identifiers, handles, platform values, or raw adapter errors.

The implementation must preserve this fork's per-series task sessions,
one-door delivery contract, provider-neutral formatter, existing DM cache
behavior, and current public interfaces.

## Upstream evidence and fork-specific decisions

- Upstream commit `9e620f86` uses `process_after ?? timestamp` for the task's
  `time` attribute and adds `current_time`. This is useful here because
  `process_after` is already present in the host schema, container test schema,
  schema contract, and `MessageInRow`.
- Do not cherry-pick `9e620f86`: its surrounding formatter includes unrelated
  legacy task-contract stripping that is not the local contract.
- Use the existing runner `formatLocalStamp()` helper for `current_time`. It is
  timezone-aware and has a stable `YYYY-MM-DD HH:mm` shape, avoiding a second
  locale-sensitive timestamp representation.
- Upstream-main commit `1ecb952f` makes redaction caller-selectable and defaults
  it off. That is unsafe against future callers. The later upstream branch
  commit `c6d4847e` makes redaction unconditional and adds sentinel-based
  leakage coverage; use that stronger contract.
- Keep `ensureUserDm(userId)` unchanged. No debug or opt-out argument may
  re-enable sensitive ordinary logs.

## Behavioral contracts

### Task prompt timestamps

- Task XML is `<task ... time="..." current_time="...">`.
- `time` is the effective row schedule: `process_after`, falling back to
  `timestamp` for legacy rows.
- `current_time` is generated when the prompt is formatted.
- Both values use the runner's effective `TIMEZONE`.
- `current_time` appears only on task elements, not chat, webhook, system, or
  agent-task elements.
- Script output, prompt text, routing attributes, XML escaping, and task
  delivery semantics remain unchanged.
- Claude compaction instructions explicitly preserve both attributes.

### DM-resolution logging

- Unknown-user and malformed-user logs contain no supplied user ID.
- Stale-cache logs contain only `channelType`, never user, handle, cached
  messaging-group ID, or platform ID.
- DM creation logs contain only `channelType`.
- Adapter-resolution failures contain only `channelType`, never the handle or
  raw error/stack.
- Missing-adapter logs may retain `channelType`; it is a registered adapter
  category, not the user's platform identity.
- Resolution, caching, row reuse, Teams-style ID parsing, and return values do
  not change.

## Regression-first implementation sequence

1. Extend the Bun formatter test helper with optional `processAfter`.
2. Add deterministic task tests for schedule precedence, legacy fallback,
   actual current time, timezone formatting, and absence on non-task rows.
   Pass a formatter clock parameter with a default of `new Date()` so tests do
   not depend on wall-clock timing or Bun fake-timer behavior.
3. Export a pure `buildCompactInstructions()` seam, retaining the executable's
   current stdout behavior, and test that task compaction preserves
   `current_time`.
4. Add a focused Vitest `user-dm.test.ts` that mocks the logger and places
   unique sentinels in every sensitive location. Serialize every info/warn/error
   call and assert that no sentinel appears.
5. Implement task rendering using `process_after ?? timestamp` and
   `formatLocalStamp(now, TIMEZONE)`.
6. Redact `ensureUserDm` logs unconditionally and discard caught adapter errors.
7. Update documentation:
   - `docs/agent-runner-details.md`: exact XML and timestamp meanings.
   - `docs/architecture.md`: provider-neutral task temporal context.
   - `docs/db-session.md`: rendering relationship between `process_after` and
     `timestamp`.
   - `docs/SECURITY.md`: cold-DM log data-minimization guarantee.
   - `docs/db-central.md`: user-DM cache logging boundary and correct source
     path.
   - `README.md`: review for stale claims; change only if a user-facing claim
     needs correction.
   - `docs/HANDOFF.local.md`: files, commands, results, and open issues.
8. Run focused tests before broad validation.

## Validation gates

Run in this order:

1. `cd container/agent-runner && bun test src/formatter.test.ts src/compact-instructions.test.ts`
2. `pnpm exec vitest run src/modules/permissions/user-dm.test.ts src/modules/permissions/permissions.test.ts`
3. `cd container/agent-runner && bun test`
4. `pnpm test`
5. `pnpm run typecheck`
6. `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
7. `pnpm run build`
8. `pnpm run format:check`
9. `git diff --check`

No service restart or container image rebuild is required for acceptance. The
runner source is bind-mounted, but running sessions would need replacement to
load it; do not interrupt active durable work as part of this change.

## Merge and rollback profile

- No database migration or schema-contract edit.
- No public CLI or runtime configuration change.
- Expected conflict surface is limited to runner formatting/compaction,
  permissions logging, tests, and documentation.
- Rollback is a normal commit revert. Existing stored task and DM rows remain
  compatible in both directions.
