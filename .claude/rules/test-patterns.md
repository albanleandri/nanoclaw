# Test Patterns

## Layout

- Unit tests live alongside source: `src/*.test.ts` and `setup/*.test.ts`.
- Run host tests with `npm test` (vitest) from the repo root.
- Agent-runner tests run under Bun from `container/agent-runner/`: `bun test`
  and `bun run test:coverage`. They are real suites and gate CI — do not
  treat them as stubs or skip them when changing container code.
- Container skill tests: `container/skills/**/test_*.py` (pytest, run inside a container).
- Always run `npm test` before marking a task complete. If the change touches
  `container/agent-runner/`, run `bun test` there too.

## Regression linkage

- When a test exists because of a specific defect, cite the issue in the file's
  header comment or on the `it(...)` — e.g. `// Regression for #2465 — ...`.
  A reader deleting or "simplifying" a test needs to know what it was buying.
- When a test pins non-obvious behaviour with no issue behind it, say what
  breaking it would cost, not what the code does.

## Cross-boundary contracts

Some invariants span two packages that cannot import each other (the host is
Node + better-sqlite3; the agent-runner is Bun + bun:sqlite, and per `AGENTS.md`
they share no modules). Those are pinned with a checked-in contract file under
`contracts/`, asserted independently from both sides:

- `contracts/protocol-tools.json` — capability/tool bindings
  (`src/capabilities/conformance.test.ts`, `container/.../tool-loop/conformance.test.ts`)
- `contracts/session-db-schema.json` — inbound.db / outbound.db table and column
  shape (`src/db/session-schema-conformance.test.ts`,
  `container/agent-runner/src/db/schema-conformance.test.ts`)
- `contracts/mcp-tool-capabilities.json` — which capability each in-process MCP
  tool belongs to (`src/capabilities/conformance.test.ts`,
  `container/agent-runner/src/mcp-tools/capability-conformance.test.ts`). The
  runner reports `tool:<name>` as the capability-audit entrypoint; the host
  rejects any entrypoint the manifest's `mcpTools` does not declare, so drift
  here silently drops audit events.

When you change one side of a contract, change the contract file and the other
side in the same patch. Do not "fix" a failing conformance test by editing only
the contract — that is the drift the test exists to catch.

There is a fourth cross-boundary invariant with **no automated check**: the
capability `version` registered in `src/capabilities/builtins/index.ts` must
stay numerically in lockstep with the matching `capabilityVersion` in the
container's `CANONICAL_CAPABILITIES` map
(`container/agent-runner/src/mcp-tools/server.ts`). `handleCapabilityAudit`
(`src/audit/host-bridge.ts`) checks `capabilityVersion !== manifest.version`
_before_ it checks the entrypoint, so a mismatch makes the host reject every
audit event for that capability outright — not a warning, a hard throw on
every call. Both sides currently read `2` for `nanoclaw.schedule-task`
(bumped together when the five scheduling MCP tools were removed), and each
side carries a comment pointing at the other, but nothing fails CI if a future
edit bumps one side and not the other. Treat any edit to either number as
touching both files, the same discipline as the three contracts above, even
though there is no `contracts/*.json` file or conformance test enforcing it.

## Coverage gates

- Host: thresholds in `vitest.config.ts`, enforced by `npm run test:coverage`.
- Agent-runner: project-wide floors in
  `container/agent-runner/scripts/check-coverage.ts`, enforced by
  `bun run test:coverage`. bunfig's own `coverageThreshold` is per-file and
  cannot express a global floor, so do not move the gate there.
- Both are ratchets set just under current numbers. Raise them when coverage
  improves; lower them only deliberately, and say why in the commit.

## Fixtures

- Prefer real in-memory or temp-dir SQLite over mocking the DB layer — most of
  this suite does, and that is why it catches real regressions. Reach for
  `vi.mock` for process/network boundaries (`child_process`, adapters), not for
  code you could simply run.
- To test a migration's data-dependent branches, rewind with
  `runMigrations(db, migrations.slice(0, index))`, plant rows in the legacy
  shape, then run the rest of the chain. See `src/db/migrations-legacy-upgrade.test.ts`.
- `vi.mock` factories are hoisted above top-level bindings — inline literals
  inside them rather than referencing a `const` declared in the file.
