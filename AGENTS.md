# Agent working agreement for this repository

## Non-negotiables
- Keep the agent-runner runtime on `@anthropic-ai/claude-agent-sdk`. Do not migrate orchestration to OpenAI Agents SDK, LangGraph, or another framework unless explicitly requested.
- The agent-runner runs on **Bun** (inside the container). The host runs on **Node + pnpm**. Do not add a tsc build step to the container — agent-runner source is bind-mounted at `/app/src` at runtime.
- Claude Code and Codex are development assistants for this repo; they are not the runtime stack.

## Environment
- Primary development happens on a remote Linux machine over SSH, usually from a VS Code terminal.
- Prefer Linux-safe commands, paths, and tooling.
- Assume commands are run from the repository root unless stated otherwise.

## First steps for any task
1. Read `README.md` and the handoff file. Prefer `docs/HANDOFF.local.md`; otherwise use `docs/HANDOFF.md`. Architecture is in `docs/architecture.md`; session-DB specifics in `docs/db.md`, `docs/db-session.md`, `docs/db-central.md`.
2. Inspect the relevant package manifests and entrypoints before editing.
3. Summarize the intended change before making large edits.
4. Prefer small, reviewable diffs.

## Canonical commands

**Host (Node + pnpm):**
- `pnpm run dev` — start host with hot reload
- `pnpm run build` — compile host TypeScript (`src/`)
- `pnpm test` — host unit tests (vitest)
- `pnpm run lint` / `pnpm run format:check` / `pnpm run format`
- `pnpm run typecheck`
- `./container/build.sh` — rebuild agent container image
- `pnpm run backup` — backup all databases

**Agent-runner (Bun — separate package tree under `container/agent-runner/`):**
- `cd container/agent-runner && bun install` — after editing agent-runner deps
- `cd container/agent-runner && bun test` — agent-runner tests
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` — container typecheck (from root)

**Service (Linux systemd):**
- `systemctl --user start|stop|restart nanoclaw`

**SQLite read-only inspection:**
- `pnpm exec tsx scripts/q.ts --readonly [--limit N] <db-path> "<SELECT ...>"` — preferred way to inspect repo SQLite databases without escalation. Read-only mode is scoped to `data/` and `groups/`, allows `SELECT`/`WITH`/read-only `PRAGMA`, enables SQLite `query_only`, rejects compound SQL, and caps output at 5,000 rows by default. Use this instead of `node -e` or writable DB helpers for database reads.

## Repository map

- `src/` — Host Node process: init, routing, delivery, sweep, session management, CLI server.
  - `src/index.ts` — entrypoint: DB init, migrations, channel adapters, delivery polls, shutdown.
  - `src/router.ts` — inbound routing: messaging group → agent group → session → `inbound.db` → wake.
  - `src/delivery.ts` — polls `outbound.db`, delivers via adapter, handles system actions.
  - `src/session-manager.ts` — resolves sessions; opens `inbound.db`/`outbound.db`; heartbeat path.
  - `src/container-runner.ts` — spawns Docker containers with session DB + outbox mounts, OneCLI `ensureAgent`.
  - `src/container-runtime.ts` — runtime selection (Docker vs Apple containers), orphan cleanup.
  - `src/channels/` — channel adapter infra (registry, Chat SDK bridge); adapters installed from `channels` branch.
  - `src/providers/` — host-side provider config; providers installed from `providers` branch.
  - `src/db/` — DB layer: migrations, CRUD for agent_groups, messaging_groups, sessions, user_roles, etc.
  - `src/modules/` — feature modules: permissions, approvals, typing, self-mod, agent-to-agent.
  - `src/cli/` — `ncl` CLI server-side: dispatch, CRUD, per-resource definitions.

- `container/agent-runner/` — Container-side Bun package. **Keep on `@anthropic-ai/claude-agent-sdk`.**
  - `container/agent-runner/src/index.ts` — poll loop, provider dispatch, MCP server entry.
  - `container/agent-runner/src/mcp-tools/` — MCP tool definitions (send_message, send_file, etc.).
  - `container/agent-runner/src/db/` — Bun-sqlite readers/writers for `inbound.db` + `outbound.db`.

- `container/skills/` — Skills mounted into every agent session at runtime. Editing here requires killing running containers.
  - `container/skills/custom/` — Private skills submodule (nanoclaw-skills). Group-specific.

- `groups/<folder>/` — Per-agent-group filesystem: `CLAUDE.md`, `container.json` (materialized at spawn), optional `agent-runner-src/` overlay. Runtime state — do not edit group folders to fix bugs; fix the templates or the code.
  - Runtime tool and skill availability is group-specific. If a capability seems missing, check that group's `containerConfig.allowedTools`, `containerConfig.enabledSkills`, `containerConfig.skillMode`, and `containerConfig.extraSkills` before assuming a bug.

- `setup/` — Step-based setup workflow and setup tests.
- `scripts/` — Utility scripts: `backup.sh`, `restore.sh`, `q.ts` (DB query wrapper).
- `docs/` — Architecture, DB schemas, migration guides, isolation model.
- `.env` — Local secrets (not committed). See `.env.example`.

## Workflow notes
- Check both `package.json` files before changing runtime or build behavior: repo root and `container/agent-runner/package.json`.
- The host and agent-runner communicate **only via session DBs** — no IPC, no shared modules, no stdin.
- Container skills are loaded at session start — kill running containers after editing `container/skills/`.
- `src/` changes require `pnpm run build` before the service picks them up.
- Agent-runner source changes don't require a container rebuild — it's bind-mounted at `/app/src` at runtime.
- `bun:sqlite` uses `$name` for named params; `better-sqlite3` (host) strips `$`. Use positional `?` for portability.
- When editing Telegram behavior, inspect both `src/channels/telegram.ts` and `src/router.ts`.
- Do not document or imply channels, services, or deployment units that are not present in the repo.
- Keep the tracked repo public-safe by default. Private/domain-specific content goes in ignored local files or a private submodule.

## Change rules
- Do not silently change public interfaces.
- Do not change deployment behavior, secrets handling, or service startup commands without documenting it.
- When adding or changing a capability, update the relevant docs and operator notes in the same patch.
- Prefer editing existing files over introducing new abstractions unless there is a clear benefit.

## Handoff protocol
After each meaningful change, update the handoff file. Prefer `docs/HANDOFF.local.md` if it exists; otherwise update `docs/HANDOFF.md`.

The tracked `docs/HANDOFF.md` should stay minimal and generic. Put sensitive, local, or domain-specific notes in `docs/HANDOFF.local.md` (intentionally ignored).

Record: current objective, files changed, commands run, test/lint status, open issues / next steps.
