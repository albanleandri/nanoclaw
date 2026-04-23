# Handoff

Use `docs/HANDOFF.local.md` for detailed local notes when available.

## Current objective
- Wire actual OneCLI gateway support into the runtime while preserving the native credential-proxy fallback.
- Align setup, verification, and docs with the real Anthropic auth model (`ONECLI_URL` + `ANTHROPIC_AUTH_MODE`) and the explicit `CONTAINER_SECRET_*` escape hatch.

## Quick context
- Single Node.js process (`src/index.ts`) routes messages to Claude Agent SDK containers.
- Each group has isolated memory (`groups/{name}/CLAUDE.md`) and filesystem.
- Container skills (`container/skills/`) are loaded at container start; changes require a rebuild and container kill.
- Anthropic credentials can route through OneCLI Agent Vault; explicit `CONTAINER_SECRET_*` vars are still opt-in raw container secrets.

## Shared conventions
- Keep the Telegram runtime on the Anthropic Agent SDK.
- Prefer repo scripts and `package.json` commands over ad hoc operational commands.
- Keep private or domain-specific notes out of the tracked repo when possible.

## Files changed (latest) — OneCLI runtime alignment

Runtime / setup:
- `src/onecli.ts` — new helper to read local OneCLI config and apply container gateway args
- `src/container-runner.ts` — applies OneCLI gateway config per group when `ONECLI_URL` is set; falls back to the native credential proxy otherwise
- `src/credential-proxy.ts` — supports explicit `ANTHROPIC_AUTH_MODE` and warns cleanly when raw native creds are absent
- `setup/verify.ts` — treats OneCLI-only installs as configured instead of requiring raw Anthropic creds in `.env`

Tests / lint cleanup:
- `src/container-runner.test.ts` — covers active OneCLI gateway config vs native fallback
- `src/credential-leak.test.ts` — verifies OneCLI mode skips native `ANTHROPIC_BASE_URL` rewrites
- `src/credential-proxy.test.ts` — covers explicit `ANTHROPIC_AUTH_MODE`
- `src/index.ts`, `src/session-commands.test.ts` — lint cleanup for unused symbols

Docs / skills:
- `.claude/skills/init-onecli/SKILL.md`, `.claude/skills/setup/SKILL.md` — document `ANTHROPIC_AUTH_MODE`, remove over-broad generic secret migration claims
- `README.md`, `docs/SECURITY.md`, `CLAUDE.md`, `.env.example` — scope OneCLI claims accurately and document the `CONTAINER_SECRET_*` exception

## Commands run
- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm test -- --run src/container-runner.test.ts src/credential-leak.test.ts`

## Test/lint status
- `npm test` passed (26 files, 385 tests).
- `npm run typecheck` passed.
- `npm run lint` still returns non-zero on the pre-existing warning backlog in `src/`; there are no new lint errors from this patch.

## Context: 2026-04-13 outage
- Service was down from ~midnight Apr 11→12.
- Restart at 17:24 Apr 12 hit EADDRINUSE on 172.17.0.1:3001 (credential proxy port held by stale state — exact cause unclear, fixed by proper awaited close).
- PID file stale (995764 dead). Messages at 20:18 and 20:24 were undelivered.
- Fixed by: (1) proper `closeCredentialProxy` shutdown, (2) systemd user service with `Restart=always`.

## Open issues / next steps
- If an existing OneCLI install uses Anthropic API keys, ensure `.env` contains `ANTHROPIC_AUTH_MODE=api-key`; OAuth-based installs should use `ANTHROPIC_AUTH_MODE=oauth`.
- Generic third-party API env vars such as `OPENAI_API_KEY` are still service-specific and are not automatically safe to migrate to OneCLI without code changes in the consuming integration.
- Calendar morning briefing: user needs to (1) add `CONTAINER_SECRET_PROTON_ICAL_URL=<url>` to `.env`, (2) restart the service, (3) tell the assistant `@Andy every day at 7am, run the calendar morning briefing using the calendar-morning skill`
- Recurring events (RRULE) are skipped in the calendar skill v1 — revisit if needed
- Future: add work calendar via `CONTAINER_SECRET_WORK_ICAL_URL`
