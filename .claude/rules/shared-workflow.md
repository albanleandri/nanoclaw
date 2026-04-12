# Shared Workflow

- `AGENTS.md` is the shared instruction source for repository-wide workflow.
- Update the handoff file after meaningful changes. Prefer `docs/HANDOFF.local.md` when present; otherwise update `docs/HANDOFF.md`.
- Prefer repo scripts and `package.json` scripts over ad hoc shell snippets when both exist.
- For dependency installation, prefer `npm run deps:install`.
- Keep the runtime on the Anthropic Agent SDK. Do not propose migrating orchestration frameworks unless explicitly requested.
