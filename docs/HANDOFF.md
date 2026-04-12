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

## Files changed
- `src/index.ts`
- `src/usage-limit.ts`
- `src/usage-limit.test.ts`
- `docs/OPERATIONS.md`
- `docs/HANDOFF.md`

## Commands run
- Read runtime, DB, and error-path files.
- Added a usage-limit helper and host-side notification flow.
- Added unit tests for detection, cooldown, and message formatting.
- Ran `npm test -- --run src/usage-limit.test.ts src/container-runner.test.ts src/task-scheduler.test.ts`
- Ran `npm run typecheck`
- Ran `npm test`
- Validated the live Telegram path and adjusted cooldown behavior to ignore later messages after the first limit notice.

## Test/lint status
- `npm run typecheck` passed.
- `npm test` passed (`23` files, `351` tests).

## Open issues / next steps
- Verify the exact provider error strings seen in production and extend parsing if Anthropic returns a different reset-time format.
- Consider applying the same short notification pattern to scheduled-task failures if operator visibility there becomes important.
