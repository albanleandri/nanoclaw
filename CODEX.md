@AGENTS.md

## Codex-only note
- Use `AGENTS.md` as the shared instruction source.
- Prefer repo scripts and `package.json` commands over repeating long shell snippets.
- For dependency installation, use `npm run deps:install`.
- For handoff context, prefer `docs/HANDOFF.local.md` when present; otherwise use the tracked `docs/HANDOFF.md`.
- Runtime tools and skills are group-specific. Non-main groups should have explicit `containerConfig.allowedTools` and `containerConfig.enabledSkills` selections.

## Codex-to-Claude handoff
If a task involves multi-file refactoring, interactive prompts, or skill execution, prefer
invoking Claude Code skills (e.g. `/customize`, `/debug`) over proposing bash-only workarounds.
Bash workarounds are harder for Claude Code to extend cleanly on the next pass.
