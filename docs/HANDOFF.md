# Handoff

Use `docs/HANDOFF.local.md` for detailed local notes when available.

## Current objective
- Keep the public fork generic and upstream-friendly while preserving a private personalization layer.
- Tighten dual-agent friendliness so Codex and Claude Code follow the same docs, wrappers, and scoped instructions.

## Quick context
- Single Node.js process (`src/index.ts`) routes messages to Claude Agent SDK containers.
- Each group has isolated memory (`groups/{name}/CLAUDE.md`) and filesystem.
- Container skills (`container/skills/`) are loaded at container start; changes require a rebuild and container kill.
- Secrets route through OneCLI Agent Vault; agents never receive raw keys.

## Shared conventions
- Keep the Telegram runtime on the Anthropic Agent SDK.
- Prefer repo scripts and `package.json` commands over ad hoc operational commands.
- Keep private or domain-specific notes out of the tracked repo when possible.

## Files changed
- `.claude/rules/shared-workflow.md`
- `.claude/rules/skill-maintenance.md`
- `.claude/skills/migrate-from-openclaw/SKILL.md`
- `.claude/skills/add-karpathy-llm-wiki/SKILL.md`
- `.claude/skills/add-whatsapp/SKILL.md`
- `.claude/skills/update-nanoclaw/SKILL.md`
- `.claude/skills/customize/SKILL.md`
- `docs/docker-sandboxes.md`
- `docs/skills-as-branches.md`
- `src/channels/AGENTS.override.md`
- `docs/HANDOFF.md`

## Commands run
- Read repo docs, manifests, override files, and scoped Claude rules.
- Searched for stale helper-script references and non-canonical setup/service commands.

## Test/lint status
- No code-path tests run; changes are limited to documentation and instruction files.
- Follow-up verification should be a quick pass for markdown accuracy and command consistency.

## Open issues / next steps
- Review remaining skill docs periodically for raw platform-specific commands that should stay only in fallback/troubleshooting sections.
- Keep private container skills and other sensitive customization layers outside the public repo surface.
