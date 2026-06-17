---
name: add-codex
description: Use Codex (OpenAI's codex app-server) as a full agent provider — planning, tool orchestration, MCP tools, server-side history, session resume — alongside or instead of Claude. ChatGPT subscription via host Codex auth or OpenAI API key via OneCLI. Per-group via `ncl groups config update --provider codex`. Distinct from using OpenAI as an MCP tool (where Claude remains the planner).
---

# Codex agent provider

> Local note: this checkout already has the Codex provider payload wired. `pnpm exec tsx setup/index.ts --step provider-auth codex` is the local auth helper; it enables ChatGPT host-file auth or creates/checks the OneCLI Codex API-key secret. The install steps below remain the provider-branch recipe for a checkout where Codex is not already wired.

NanoClaw selects each group's agent backend from `container_configs.provider` (default `claude`). This skill installs the Codex provider: copy the payload from the `providers` branch, append one import to each of the three provider barrels, add the pinned Codex CLI to the container manifest (`container/cli-tools.json`), rebuild, then run the vault auth walk-through.

The provider runs `codex app-server` as a child process speaking JSON-RPC over stdio: native streaming, MCP tools, server-side conversation history (the continuation is a thread id, no on-disk transcript). Credentials are explicit per auth mode: API-key auth stays in OneCLI; ChatGPT subscription auth is enabled with `CODEX_CHATGPT_AUTH=host-file`, which copies the host `~/.codex/auth.json` into the Codex group private state. No `OPENAI_API_KEY` is passed through `.env` or the Codex process environment.

## Install

### Pre-flight

Check whether the payload is already wired (a prior apply, or a trunk that still carries it). All of these present means installed — skip to **Authenticate**:

- `src/providers/codex.ts` and `src/providers/codex-agents-md.ts`
- `container/agent-runner/src/providers/codex.ts` and `codex-app-server.ts`
- `setup/provider-auth.ts`
- `import './codex.js';` in `src/providers/index.ts` and `container/agent-runner/src/providers/index.ts`
- an `@openai/codex` entry in `container/cli-tools.json`

### Fetch and copy

```bash
git fetch origin providers
```

Copy each file with `git show origin/providers:<path> > <path>` (additive — never merge the branch):

Host (`src/providers/`):

- `codex.ts` — provider contribution: per-group `.codex-shared` state dir, AGENTS.md compose, skill links
- `codex-agents-md.ts` — AGENTS.md composition (32KB Codex cap: degrades by dropping the largest instruction sections, never blocks a spawn)
- `codex-registration.test.ts` — barrel-driven host registration guard
- `codex-host-contribution.test.ts` — drives the real contribution against a real test DB (the "consumes core" leg)
- `codex-agents-md.test.ts` — cap-degradation behavior

Container (`container/agent-runner/src/providers/`):

- `codex.ts` — the provider (turn loop, steering, memory scaffold + `onExchangeComplete` archiving)
- `codex-app-server.ts` — JSON-RPC child-process wrapper
- `exchange-archive.ts` — per-exchange markdown writer the `onExchangeComplete` hook uses (provider-owned, not runner code)
- `exchange-archive.test.ts` — writer behavior
- `codex-registration.test.ts` — barrel-driven container registration guard
- `codex.factory.test.ts`, `codex.turns.test.ts`, `codex-app-server.test.ts` — provider behavior
- `codex-cli-tools.test.ts` — structural guard for the Codex entry in `container/cli-tools.json`

Local setup:

- `setup/provider-auth.ts` — Codex OneCLI auth check/API-key registration step

Shared base (skip if present):

- `container/AGENTS.md` — the runtime-contract base the composed AGENTS.md embeds

### Wire the barrels

Append `import './codex.js';` to each of:

- `src/providers/index.ts`
- `container/agent-runner/src/providers/index.ts`

### CLI manifest

The agent's global Node CLIs install from `container/cli-tools.json` (a json-merge seam), not hand-edited Dockerfile layers. Add Codex by appending one entry — `@openai/codex` has no native postinstall, so no `onlyBuilt`:

```bash
node -e '
  const fs = require("fs");
  const file = "container/cli-tools.json";
  const tools = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!tools.some((t) => t.name === "@openai/codex")) {
    tools.push({ name: "@openai/codex", version: "0.140.0" });
    const fmt = (t) => "  { " + Object.entries(t).map(([k, v]) => JSON.stringify(k) + ": " + JSON.stringify(v)).join(", ") + " }";
    fs.writeFileSync(file, "[\n" + tools.map(fmt).join(",\n") + "\n]\n");
  }
'
```

The local pin is `0.140.0`, matching the host `codex-cli 0.140.0` observed on this checkout and `container/cli-tools.json`. The Dockerfile installs every manifest entry via pinned `pnpm install -g`; no Dockerfile edit is needed.

### Build

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

### Validate

```bash
pnpm vitest run src/providers/codex-registration.test.ts src/providers/codex-host-contribution.test.ts src/providers/codex-agents-md.test.ts
cd container/agent-runner && bun test src/providers/
```

The registration tests import only the real barrels — they go red if a barrel line is missing, a barrel fails to evaluate, or the payload is broken.

## Authenticate

```bash
pnpm exec tsx setup/index.ts --step provider-auth codex
```

For ChatGPT subscription auth, first make sure the host Codex CLI is logged in (`codex login -c 'cli_auth_credentials_store="file"' --device-auth` if needed), then run:

```bash
pnpm exec tsx setup/index.ts --step provider-auth codex --chatgpt
```

That writes `CODEX_CHATGPT_AUTH=host-file` to `.env` and seeds existing Codex group `.codex-shared/auth.json` files without printing token contents. For API-key auth instead, use `pnpm exec tsx setup/index.ts --step provider-auth codex --api-key <OPENAI_API_KEY>`, which stores the key in OneCLI as a generic `api.openai.com` secret.

## Use it

Per group:

```bash
ncl groups config update --id <group-id> --provider codex
ncl groups restart --id <group-id>
```

Switching is an operator action — run it from the host. Memory does NOT carry over automatically — each provider keeps its own store; run `/migrate-memory` to carry it across. See [docs/provider-migration.md](../../docs/provider-migration.md) for the carry-over table and rollback.

There is no install-wide default provider. Setup's provider picker sets codex on the first agent it creates; creation itself is provider-agnostic (no `--provider` flag — provider is a DB property). Any group switches afterward via `ncl groups config update --provider` as above.

## Troubleshooting

- **Container dies at boot, channel silent:** `grep 'Container exited non-zero' logs/nanoclaw.error.log` — the `stderrTail` carries the reason (e.g. `Unknown provider: codex. Registered: claude` means the barrels aren't wired in the running build).
- **In-channel `Error: spawn codex ENOENT` on every message:** the image predates the manifest entry — re-run `./container/build.sh`.
- **Auth errors mid-conversation:** run `pnpm exec tsx setup/index.ts --step provider-auth codex --check`. If `CHATGPT_AUTH_ENABLED` is false, run `codex login -c 'cli_auth_credentials_store="file"' --device-auth` on the host and then `pnpm exec tsx setup/index.ts --step provider-auth codex --chatgpt`. If you chose API-key auth, confirm the OneCLI `api.openai.com` secret exists.
