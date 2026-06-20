# Handoff

This is the tracked, public handoff stub. Keep it minimal and generic.

Real, sensitive, local, or domain-specific handoff notes go in
`docs/HANDOFF.local.md` (gitignored, never committed). Agents and contributors
should prefer `docs/HANDOFF.local.md` when present and fall back to this file
otherwise.

## Conventions

- Host runs on Node + pnpm (`src/`); the agent-runner runs on Bun
  (`container/agent-runner/`). They communicate only via the per-session DBs.
- Architecture: `docs/architecture.md`. DB model: `docs/db.md`.
- After each meaningful change, record current objective, files changed,
  commands run, and test/lint status in `docs/HANDOFF.local.md`.
