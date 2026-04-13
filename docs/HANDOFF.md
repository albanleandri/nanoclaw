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
- `src/credential-proxy.ts` — added `closeCredentialProxy()` export (calls `closeAllConnections()` + awaits `close` event)
- `src/index.ts` — shutdown handler now `await closeCredentialProxy(proxyServer)` instead of fire-and-forget `proxyServer.close()`
- `src/credential-proxy.test.ts` — new test verifying prompt close under keep-alive connection; `afterEach` guarded with `.listening` check
- `~/.config/systemd/user/nanoclaw.service` — user-level systemd unit created by `npm run setup:step -- service`; linger enabled

## Commands run
- `npm test` → 352 tests, all pass
- `npm run build`
- `npm run setup:step -- service` (created + enabled + started systemd user unit)

## Test/lint status
- `npm test` passed (23 files, 352 tests).

## Context: 2026-04-13 outage
- Service was down from ~midnight Apr 11→12.
- Restart at 17:24 Apr 12 hit EADDRINUSE on 172.17.0.1:3001 (credential proxy port held by stale state — exact cause unclear, fixed by proper awaited close).
- PID file stale (995764 dead). Messages at 20:18 and 20:24 were undelivered.
- Fixed by: (1) proper `closeCredentialProxy` shutdown, (2) systemd user service with `Restart=always`.

## Open issues / next steps
- Verify the exact provider error strings seen in production and extend parsing if Anthropic returns a different reset-time format.
- Consider applying the same short notification pattern to scheduled-task failures if operator visibility there becomes important.
