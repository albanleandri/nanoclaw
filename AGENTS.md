# Agent working agreement for this repository

## Non-negotiables
- Keep the Telegram agent runtime on the Anthropic Agent SDK.
- Do not migrate the runtime/orchestration to OpenAI Agents SDK, LangGraph, or another orchestration framework unless explicitly requested.
- Codex and Claude Code are development assistants for this repo; they are not the runtime stack.

## Environment
- Primary development happens on a remote Linux machine over SSH, usually from a VS Code terminal.
- Prefer Linux-safe commands, paths, and tooling.
- Assume commands are run from the repository root unless stated otherwise.

## First steps for any task
1. Read `README.md`, `docs/README.md`, `docs/REQUIREMENTS.md`, and the handoff file if present. Prefer `docs/HANDOFF.local.md`; otherwise use `docs/HANDOFF.md`. There is no `docs/ARCHITECTURE.md` in this repo at the moment.
2. Inspect the relevant package manifests and entrypoints before editing.
3. Summarize the intended change before making large edits.
4. Prefer small, reviewable diffs.

## Canonical commands
- Install dependencies:
  - `npm run deps:install`
- Start dev environment:
  - `npm run dev`
  - `npm run setup:bootstrap`
  - `npm run setup:step -- <timezone|environment|container|groups|register|mounts|service|verify> [step args...]`
- Run tests:
  - `npm test`
- Run lint/format:
  - `npm run lint`
  - `npm run format:check`
  - `npm run format` or `npm run format:fix`
- Run typecheck/build:
  - `npm run typecheck`
  - `npm run build`
  - `npm run container:build`
- Service operations:
  - `npm run service:status`
  - `npm run service:restart`

## Repository map
- `src/`
  - Main Node.js orchestrator and app runtime.
  - `src/index.ts` is the main entrypoint for polling, routing, scheduling, group state, and container invocation.
  - `src/container-runner.ts` and `src/container-runtime.ts` manage agent container execution and runtime lifecycle.
  - `src/channels/telegram.ts` contains the Telegram transport / bot integration.
  - `src/channels/registry.ts` and `src/channels/index.ts` handle channel registration.
  - `src/session-commands.ts`, `src/task-scheduler.ts`, and `src/remote-control.ts` implement operator-facing capabilities.
- `container/agent-runner/`
  - Container-side runner package.
  - `container/agent-runner/src/index.ts` is the Anthropic Agent SDK entrypoint that runs inside the container.
  - Keep this runtime on `@anthropic-ai/claude-agent-sdk`.
- `container/skills/`
  - Skills and tools loaded inside agent containers.
  - Includes built-in capabilities such as `agent-browser`, `capabilities`, `polymarket`, `status`, and stock-market-related skills.
- `setup/`
  - Step-based setup workflow and setup tests.
  - `setup/index.ts` dispatches setup steps such as environment, container, groups, service, and verify.
- `scripts/`
  - Utility and migration scripts such as `scripts/run-migrations.ts`.
- `groups/`
  - Group-specific memory and defaults.
  - `groups/main/CLAUDE.md` and `groups/global/CLAUDE.md` are templates copied into group folders.
- `config-examples/`
  - Configuration and security examples, including `mount-allowlist.json`.
- Repo root config and secrets templates
  - `.env.example` documents environment variables.
  - `src/config.ts` resolves runtime configuration from `.env` and process env.
- Tests
  - Root/unit tests live alongside source as `src/*.test.ts` and `setup/*.test.ts`.
  - Container skill tests exist under skill directories such as `container/skills/stock-market-investing/test_*.py`.
- Deployment / ops
  - `start-nanoclaw.sh` starts the built app without systemd.
  - `container/build.sh` builds the agent container image.
  - `launchd/com.nanoclaw.plist` is the shipped launchd example.
  - `setup.sh` exists at repo root for setup automation.

## Workflow notes
- This repo is usually worked on over SSH from VS Code on a remote Linux machine. Prefer Linux-safe commands and paths in docs and changes.
- Check both `package.json` files before changing runtime or build behavior: repo root and `container/agent-runner/package.json`.
- When editing Telegram behavior, inspect both `src/channels/telegram.ts` and the orchestrator path in `src/index.ts`.
- Prefer repo-level scripts and `package.json` scripts over ad hoc shell snippets when documenting or automating common operations.
- Do not document or imply channels, services, or deployment units that are not present in the repo.
- If you change setup steps, startup flow, secrets handling, mounts, or service behavior, update docs in the same patch.

## Change rules
- Do not silently change public interfaces.
- Do not change deployment behavior, secrets handling, or service startup commands without documenting it.
- When adding or changing a capability, update the relevant docs and operator notes.
- Prefer editing existing files over introducing new abstractions unless there is a clear benefit.

## Handoff protocol
After each meaningful change, update the handoff file. Prefer `docs/HANDOFF.local.md` if it exists; otherwise update `docs/HANDOFF.md`.

The tracked `docs/HANDOFF.md` should stay minimal and generic. Put sensitive, local, or domain-specific notes in `docs/HANDOFF.local.md`, which is intentionally ignored.

Record:
- current objective
- files changed
- commands run
- test/lint status
- open issues / next steps
