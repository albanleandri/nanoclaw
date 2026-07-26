# Claude Code repository instructions

@AGENTS.md

Use `AGENTS.md` as the canonical working agreement for this repository.
Claude Code and Codex are development assistants; neither is the NanoClaw
runtime stack.

Claude-specific notes:

- Keep additions here small and non-conflicting with `AGENTS.md`.
- Prefer repository scripts and `package.json` commands over duplicated shell
  recipes.
- Read `docs/HANDOFF.local.md` when present; otherwise read
  `docs/HANDOFF.md`.
- Treat `README.md` and the current references linked from
  `docs/README.md` as implementation documentation. Design specs and the
  changelog are historical context unless a current reference explicitly
  adopts them.
- Runtime tools and skills are group-specific. Check the effective group
  configuration before treating a missing capability as a runtime defect.
