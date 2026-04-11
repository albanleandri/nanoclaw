# Agent Runner Override

- This directory is the container-side runtime package.
- Keep the runtime on `@anthropic-ai/claude-agent-sdk`.
- Do not migrate orchestration in this directory to OpenAI Agents SDK, LangGraph, or another framework unless explicitly requested.
- Before editing here, inspect both `container/agent-runner/package.json` and `container/agent-runner/src/index.ts`.
- When changes here affect container startup or IO protocol, also review root-level callers such as `src/container-runner.ts`.
