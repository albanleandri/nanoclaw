# Build & Runtime

NanoClaw runs a split stack: the host is Node + pnpm, the agent container is Bun. They communicate exclusively through two SQLite files per session — there are no shared modules between them, which is what lets them use different runtimes cleanly.

## Why the split

- **Host stays on Node** because Baileys (WhatsApp) depends on `libsignal-node` native bindings and a long-tested WebSocket/HTTP stack. Bun's Node-API compat has improved, but this isn't where we want risk.
- **Container runs Bun** because `bun:sqlite` is built-in (no native compile of `better-sqlite3` per image rebuild), source runs directly (no tsc build step at image build or session wake), and `bun install` is ~5-10× faster than `npm install`.

Host and container each have their own package tree:

```
/                             pnpm + Node 22
  pnpm-lock.yaml              host deps (channels, Chat SDK, Baileys, better-sqlite3, etc.)
  pnpm-workspace.yaml         minimumReleaseAge + onlyBuiltDependencies policy

/container/agent-runner/      Bun 1.3+
  bun.lock                    agent-runner runtime deps (Claude Agent SDK, MCP SDK, zod, etc.)
  package.json                @types/bun, typescript devDeps for type-checking
```

The container image also has pnpm + Node inside for global CLIs (`@anthropic-ai/claude-code`, `agent-browser`, `vercel`). Those are Node binaries the agent invokes at runtime, not library deps. Keeping them on pnpm preserves the supply-chain policy for CLI versions.

## Lockfiles

| Tree         | Lockfile                          | Manager  | Regenerate after dep change                |
| ------------ | --------------------------------- | -------- | ------------------------------------------ |
| Host         | `pnpm-lock.yaml`                  | pnpm 10  | `pnpm install`                             |
| Agent-runner | `container/agent-runner/bun.lock` | Bun 1.3+ | `cd container/agent-runner && bun install` |

Both are committed. CI and the Dockerfile run `--frozen-lockfile` variants — any drift between `package.json` and lockfile fails the build.

## Supply chain

- **Host + global CLIs** (pnpm): `minimumReleaseAge: 4320` (3-day hold on new versions), `onlyBuiltDependencies` allowlist for postinstall scripts. See `pnpm-workspace.yaml` and `docs/SECURITY.md`.
- **Agent-runner** (Bun): `bunfig.toml` applies the same three-day release-age
  hold to direct and transitive dependency resolution. `bun.lock` and targeted
  security overrides keep the reviewed graph reproducible. When bumping
  `@anthropic-ai/claude-agent-sdk` or another runtime dependency, still review
  its release notes and resolved graph deliberately.

## Image build surface

`container/Dockerfile` is a single-stage build on `node:22-slim`:

- **Pinned runtime/tool versions** — `BUN_VERSION`, `PNPM_VERSION`, and
  `RTK_VERSION` are Dockerfile arguments; global Node CLIs are pinned in
  `container/cli-tools.json`. Bump them deliberately in reviewed changes.
- **Per-group images** — a group with its own apt/npm packages runs
  `<base>:<group-id>`, built FROM the base image. After a default `latest`
  build, `container/build.sh` runs `scripts/rebuild-group-images.ts` so those
  groups pick up the new base too (otherwise they silently keep the previous
  runtime, e.g. an older Claude Code). Running containers keep their image
  until they next start. `SKIP_GROUP_IMAGES=1` opts out.
- **CJK fonts** — `ARG INSTALL_CJK_FONTS=false`. `container/build.sh` reads `INSTALL_CJK_FONTS` from `.env` and passes it through. Default build saves ~200MB; opt in when the user works with Chinese/Japanese/Korean content.
- **BuildKit cache mounts** — `/var/cache/apt`, `/var/lib/apt`, `/root/.bun/install/cache`, `/root/.cache/pnpm`. Rebuilds where `package.json`/`bun.lock` haven't changed are fast. Requires BuildKit (default on Docker 23+, Apple Container-compat).
- **`tini` as init** — reaps Chromium zombies, forwards signals so in-flight `outbound.db` writes finalize on SIGTERM.
- **`entrypoint.sh`** (extracted) — `exec bun run /app/src/index.ts` under tini. Readable and diffable.
- **No compiled `/app/dist`** — Bun runs TS directly. The host bind-mounts
  `container/agent-runner/src` over `/app/src` at session start, so runner
  source edits take effect in newly spawned containers without rebuilding the
  image.

## Session wake (two paths)

1. **Base image ENTRYPOINT** — used for stdin-piped test invocations like the sample in `container/build.sh`: `tini --> entrypoint.sh` captures stdin to `/tmp/input.json`, then `exec bun run src/index.ts`.
2. **Host-spawned session** — `src/container-runner.ts` at line ~301 uses `--entrypoint bash` with `-c 'exec bun run /app/src/index.ts'`. Bypasses tini (Docker's default PID 1 handling applies). Stdin is unused; all IO flows through the mounted session DBs.

Both paths end with Bun running the same source file from `/app/src/index.ts`.

## CI shape

`.github/workflows/ci.yml` installs both Node (with pnpm cache) and Bun, then runs in order:

1. `pnpm install --frozen-lockfile` (host)
2. `bun install --frozen-lockfile` in `container/agent-runner/` (container)
3. `pnpm run format:check`
4. `pnpm exec tsc --noEmit` (host typecheck)
5. `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` (container typecheck)
6. `pnpm exec vitest run` and `pnpm run test:coverage` (host)
7. `bun test` and `bun run test:coverage` in
   `container/agent-runner/` (container)

Any failure fails the PR.

## Key invariants

- **Session DBs must use `journal_mode=DELETE`.** WAL's `-shm` memory-map doesn't cross VirtioFS between host and guest. See the doc comment at the top of `container/agent-runner/src/db/connection.ts` and `src/session-manager.ts`.
- **Named SQL parameters in the container require the prefix in JS object keys.** `bun:sqlite` does not auto-strip `@`/`$`/`:` the way `better-sqlite3` does on the host. Use `$name` in both SQL and keys: `.run({ $id: msg.id })`. Positional `?` params work normally.
- **Agent-runner tests run under `bun:test`, not vitest.** `vitest.config.ts` excludes the `container/agent-runner/` tree because vitest runs on Node and can't load `bun:sqlite`.
- **No tsc build step in the container image.** Re-adding one would reintroduce the ~200-500ms per-session-wake cost we removed.
- **Global container CLIs stay on pnpm, not Bun.** `agent-browser`, `@anthropic-ai/claude-code`, `vercel` and any future Node CLIs the agent invokes should be pinned versions under the Dockerfile's pnpm global-install block. `bun install -g` would bypass the pnpm supply-chain policy.

## Migration history

This structure replaced a uniform npm-on-Node stack across both host and container. The pnpm migration landed first (PR #1771) to bring the host under supply-chain policy, then the container moved to Bun to eliminate native-module compilation and the per-wake tsc step. The split was chosen over going full-Bun because Baileys' native deps are the main risk surface on the host — the container has no such deps, so it benefits from Bun without taking the risk.
