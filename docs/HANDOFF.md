# Handoff

Use `docs/HANDOFF.local.md` for detailed local notes when available.

## Current objective
- Make the Polymarket researcher volume ceiling configurable per run while raising the default sweet-spot ceiling to $5,000.

## Quick context
- Single Node.js process (`src/index.ts`) routes messages to Claude Agent SDK containers.
- Each group has isolated memory (`groups/{name}/CLAUDE.md`) and filesystem.
- Container skills (`container/skills/`) are loaded at container start; changes require a rebuild and container kill.
- Anthropic credentials can route through OneCLI Agent Vault; explicit `CONTAINER_SECRET_*` vars are still opt-in raw container secrets.

## Shared conventions
- Keep the Telegram runtime on the Anthropic Agent SDK.
- Prefer repo scripts and `package.json` commands over ad hoc operational commands.
- Keep private or domain-specific notes out of the tracked repo when possible.

## Files changed (latest) — Polymarket researcher sharpening

Nested `container/skills` repo:
- `polymarket/polymarket_researcher.py` — raises default `MAX_VOLUME` to `$5,000`, adds `--max-volume`/`--volume-ceiling` and prompt/env ceiling parsing, and treats explicit ceilings as hard caps for recent and non-recent markets.
- `polymarket/test_polymarket_researcher.py` — covers amount parsing, prompt extraction, default `$5,000` behavior, and custom hard-cap filtering.
- `polymarket/SKILL.md`, `polymarket/DOCS.md` — document per-run ceiling prompts and the new default.
- `polymarket/polymarket_researcher.py` — adds a crowd-inefficiency prior, caps cold AI evaluations per scan, excludes very high-volume recent markets, shrinks AI probabilities toward market odds for ranking/sizing, reports risk-adjusted EV/Kelly, and appends positive evaluations to `evaluation_history`.
- `polymarket/polymarket_researcher.py` — now routes meaningful Haiku edges through factor decomposition, targeted snippet search, and Sonnet evidence adjudication before final probability/EV/Kelly.
- `polymarket/test_polymarket_researcher.py` — covers conservative shrinkage, recent-volume cap, candidate prioritization, and AI-evaluation deferral.
- `polymarket/test_polymarket_researcher.py` — updated edge-routing tests to require factor research for meaningful/large Haiku edges.
- `polymarket/SKILL.md`, `polymarket/DOCS.md` — document the strengthened methodology, risk-adjusted math, token controls, and learning/history loop.
- `polymarket/SKILL.md`, `polymarket/DOCS.md` — document factor-based research, research triggers, evidence adjudication, and search budget caps.
- `polymarket/DOCS.md` — added a durable future-improvement roadmap covering outcome ingestion, calibration, domain adapters, live odds recheck, category-aware decomposition, evidence quality, portfolio controls, watchlists, resolution audits, and execution feedback.

## Commands run
- `npm run container:build`
- `npm run service:restart`
- `npm run service:status`
- `python3 -m py_compile container/skills/polymarket/polymarket_researcher.py`
- `python3 -m pytest container/skills/polymarket/ -v`
- `python3 -m pytest container/skills/polymarket/ -v`
- `python3 -m py_compile container/skills/polymarket/polymarket_researcher.py`
- `python3 -m pytest container/skills/polymarket/ -v`

## Test/lint status
- Polymarket skill tests passed: 80 tests.
- Python bytecode compilation passed for `polymarket_researcher.py`.
- Agent container image rebuilt successfully as `nanoclaw-agent:latest`.
- `nanoclaw.service` restarted and verified active on 2026-04-26.
- Full repo `npm test`, `npm run typecheck`, and `npm run lint` were not rerun for this Python/doc-only nested skill change.

## Context: 2026-04-13 outage
- Service was down from ~midnight Apr 11→12.
- Restart at 17:24 Apr 12 hit EADDRINUSE on 172.17.0.1:3001 (credential proxy port held by stale state — exact cause unclear, fixed by proper awaited close).
- PID file stale (995764 dead). Messages at 20:18 and 20:24 were undelivered.
- Fixed by: (1) proper `closeCredentialProxy` shutdown, (2) systemd user service with `Restart=always`.

## Open issues / next steps
- Polymarket learning is now recorded with evidence metadata, but resolved-outcome ingestion is still missing. Next improvement: fetch settled outcomes, compute calibration curves/Brier/log loss/realized P&L, and tune shrinkage + thresholds from actual history.
- Search currently uses DuckDuckGo's HTML endpoint for keyless snippet retrieval. This keeps setup simple but is less robust than a paid search API or domain-specific feeds.
- The local task/group database did not show an active Polymarket scheduled task or a Polymarket-enabled registered group at the time of inspection.
- If an existing OneCLI install uses Anthropic API keys, ensure `.env` contains `ANTHROPIC_AUTH_MODE=api-key`; OAuth-based installs should use `ANTHROPIC_AUTH_MODE=oauth`.
- Generic third-party API env vars such as `OPENAI_API_KEY` are still service-specific and are not automatically safe to migrate to OneCLI without code changes in the consuming integration.
- Calendar morning briefing: user needs to (1) add `CONTAINER_SECRET_PROTON_ICAL_URL=<url>` to `.env`, (2) restart the service, (3) tell the assistant `@Andy every day at 7am, run the calendar morning briefing using the calendar-morning skill`
- Recurring events (RRULE) are skipped in the calendar skill v1 — revisit if needed
- Future: add work calendar via `CONTAINER_SECRET_WORK_ICAL_URL`
