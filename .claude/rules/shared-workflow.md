# Shared Workflow

- `AGENTS.md` is the shared instruction source for repository-wide workflow.
- Update `docs/HANDOFF.md` after meaningful changes.
- Prefer repo scripts and `package.json` scripts over ad hoc shell snippets when both exist.
- For dependency installation, prefer `npm run deps:install`.
- Keep the runtime on the Anthropic Agent SDK. Do not propose migrating orchestration frameworks unless explicitly requested.
