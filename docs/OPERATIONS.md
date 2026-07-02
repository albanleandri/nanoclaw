# Operations

Canonical operational commands for both Codex and Claude Code live here.
Run them from the repository root. The host uses Node + pnpm; the container
runner uses Bun.

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

## Usage-Limit Replies

- If the provider returns a classified quota/auth error, or a recognized bare
  429/401 result, the runner writes a short user-facing notification instead
  of failing silently.
- NanoClaw does not maintain a host-side provider cooldown. Later messages are
  processed normally and may receive another provider error.
