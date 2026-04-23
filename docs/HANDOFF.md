# Handoff

Use `docs/HANDOFF.local.md` for detailed local notes when available.

## Current objective
- Keep the public fork generic and upstream-friendly while preserving a private personalization layer.
- Surface provider usage-limit failures to chats with a short retry message, then silently drop later messages during the cooldown window.

## Quick context
- Single Node.js process (`src/index.ts`) routes messages to Claude Agent SDK containers.
- Each group has isolated memory (`groups/{name}/CLAUDE.md`) and filesystem.
- Container skills (`container/skills/`) are loaded at container start; changes require a rebuild and container kill.
- Secrets route through OneCLI Agent Vault; agents never receive raw keys.

## Shared conventions
- Keep the Telegram runtime on the Anthropic Agent SDK.
- Prefer repo scripts and `package.json` commands over ad hoc operational commands.
- Keep private or domain-specific notes out of the tracked repo when possible.

## Files changed (latest) — macro analyst feature

Container skills (`container/skills` submodule):
- `agents/macro-analyst.md` — new standalone macro environment agent
- `stock-market-investing/references/macro-analysis-checklist.md` — macro analysis logic (evolvable)
- `stock-market-investing/templates/macro-template.md` — Telegram output format for macro reports
- `stock-market-investing/SKILL.md` — coordinator: macro routing, standalone macro section, DD pre-flight steps (2-3)
- `agents/stock-dd-writer.md` — accepts optional `MACRO_SNAPSHOT:` input, renders 🌍 MACRO CONTEXT section
- `stock-market-investing/templates/due-diligence-template.md` — added macro context section placeholder
- `stock-market-investing-reference/SKILL.md` — added macro checklist + template paths
- `stock-market-investing/save_report.py` — added `macro_context` to `VALID_TYPES`
- `stock-market-investing/test_save_report.py` — new; tests save_report with macro_context type

Main repo:
- `docs/superpowers/specs/2026-04-15-macro-analyst-design.md` — design spec
- `docs/superpowers/plans/2026-04-15-macro-analyst.md` — implementation plan

## Commands run
- `npm test` → 362 tests, all pass (pre- and post-merge)
- `npm run container:build` → build complete
- `npm run service:restart` → PID 1249758

## Test/lint status
- `npm test` passed (24 files, 362 tests).

## Context: 2026-04-13 outage
- Service was down from ~midnight Apr 11→12.
- Restart at 17:24 Apr 12 hit EADDRINUSE on 172.17.0.1:3001 (credential proxy port held by stale state — exact cause unclear, fixed by proper awaited close).
- PID file stale (995764 dead). Messages at 20:18 and 20:24 were undelivered.
- Fixed by: (1) proper `closeCredentialProxy` shutdown, (2) systemd user service with `Restart=always`.

## Open issues / next steps
- Verify the exact provider error strings seen in production and extend parsing if Anthropic returns a different reset-time format.
- Consider applying the same short notification pattern to scheduled-task failures if operator visibility there becomes important.
- Calendar morning briefing: user needs to (1) add `CONTAINER_SECRET_PROTON_ICAL_URL=<url>` to `.env`, (2) restart the service, (3) tell the assistant `@Andy every day at 7am, run the calendar morning briefing using the calendar-morning skill`
- Recurring events (RRULE) are skipped in the calendar skill v1 — revisit if needed
- Future: add work calendar via `CONTAINER_SECRET_WORK_ICAL_URL`
