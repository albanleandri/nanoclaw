@AGENTS.md

## Codex-only note
- Use `AGENTS.md` as the shared instruction source. Keep Codex-specific additions here small and non-conflicting.
- Host uses **pnpm**, not npm. Agent-runner uses **Bun**. Use `pnpm` for host commands; use `bun` inside `container/agent-runner/`.
- For handoff context, prefer `docs/HANDOFF.local.md` when present; otherwise use `docs/HANDOFF.md`.
- Runtime tools and skills are group-specific. New non-main groups should have explicit `containerConfig.allowedTools` and `containerConfig.enabledSkills` selections.
- Agent-runner source changes don't require a container rebuild (bind-mounted at `/app/src`). Host `src/` changes require `pnpm run build`.

## Codex-to-Claude handoff
If a task involves multi-file refactoring, interactive prompts, or skill execution, prefer
invoking Claude Code skills (e.g. `/customize`, `/debug`) over proposing bash-only workarounds.
Bash workarounds are harder for Claude Code to extend cleanly on the next pass.
