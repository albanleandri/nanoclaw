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

## Files changed (latest)
- `src/env.ts` — added `readEnvFileByPrefix(prefix)` export; reads `.env` and returns all keys matching the given prefix
- `src/env.test.ts` — new unit tests for `readEnvFileByPrefix`
- `src/container-runner.ts` — imports `readEnvFileByPrefix`; `buildContainerArgs` now forwards all `CONTAINER_SECRET_*` vars from `.env` as `-e` flags to the container
- `src/container-runner.test.ts` — two new tests verifying `CONTAINER_SECRET_*` forwarding behaviour
- `container/skills/calendar-morning/SKILL.md` — new container skill: fetches Proton Calendar via iCal URL, parses next 2-3 days, sends a morning briefing
- `.env.example` — documents `CONTAINER_SECRET_PROTON_ICAL_URL`

## Commands run
- `npm test` → 362 tests, all pass

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
