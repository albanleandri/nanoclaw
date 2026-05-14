# Agent Runner Override

- This directory is the container-side runtime package (Bun, not Node).
- Keep the runtime on `@anthropic-ai/claude-agent-sdk`. Do not migrate orchestration to OpenAI Agents SDK, LangGraph, or another framework unless explicitly requested.
- The agent-runner is NOT compiled — source is bind-mounted at `/app/src` at runtime. There is no build step here; editing files takes effect after killing running containers.
- Before editing here, inspect both `container/agent-runner/package.json` and `container/agent-runner/src/index.ts`.
- When changes here affect the session DB protocol or IO interface, also review root-level callers such as `src/container-runner.ts`.
- `bun:sqlite` uses `$name` params for named bindings (unlike `better-sqlite3` on the host which strips `$`). Use positional `?` params when writing code that must work on both sides.
