# Stock Workflow Restructure — Design Spec

**Date:** 2026-04-06  
**Status:** Approved

---

## Problem

The current stock analysis workflow (DD and technical analysis) has two reliability failures:

1. **DD Telegram delivery is broken** — the subagent returns a session summary to Andy instead of the full memo. Andy then forwards the summary, not the artifact.
2. **Technical analysis save never happens** — `save_report.py` is supposed to be called by the TA subagent, but isn't.

Both failures share the same root cause: **save and delivery are baked into subagent prompts**, and subagent prompt compliance is not a reliable guarantee. Attempts to enforce compliance via stronger prompt instructions (`"call send_message first"`, `"do not delegate"`, `"return only a short confirmation"`) have all failed.

A code-level fix in `index.ts` (post-run DB polling) was added but does not trigger reliably.

---

## Solution: Three-layer separation

Replace the current spread-across-skills design with three clearly separated layers:

### Layer 1 — Coordinator skill
**File:** `container/skills/stock-market-investing/SKILL.md`

- Classifies the incoming request (DD / TA / screener / query / portfolio)
- Invokes the right subagent via `Task`
- Receives the complete artifact from the subagent
- Calls `save_report.py` to persist the artifact
- Calls `mcp__nanoclaw__send_message` to deliver it
- Returns a short confirmation

The coordinator owns all save and delivery steps. It contains **no analysis logic** — no frameworks, no scoring rules, no format instructions. It is short, procedural, and orchestration-only.

### Layer 2 — Reference material
**Directory:** `container/skills/stock-market-investing/`

Supports analysis quality without owning orchestration or side effects:

- `references/screener-schema.md` — DB tables, field definitions, example queries (moved from `DOCS.md`)
- `references/due-diligence-checklist.md` — five analysis lenses (business quality, financial health, valuation, growth, risk)
- `references/technical-analysis-checklist.md` — TA steps, indicator interpretation, entry zone logic
- `references/recommendation-rules.md` — scoring weights, verdict thresholds, confidence levels, entry zone taxonomy
- `templates/due-diligence-template.md` — memo sections, Telegram markdown format
- `templates/technical-template.md` — report sections, Telegram markdown format
- `examples/` — illustrative output examples (populated over time)

These files help Claude reason well. They do not control execution.

### Layer 3 — Specialized subagents
**Directory:** `container/agents/`

Each agent has one role, produces one artifact, owns no side effects:

- `stock-dd-writer.md` — performs due diligence, returns the complete investment memo plus metadata (ticker, recommendation label)
- `stock-technical-analyst.md` — performs technical analysis, returns the complete report plus metadata (ticker, entry_zone)

Both agent files explicitly state:
- Do not call `send_message`
- Do not call `save_report.py`
- Do not return a summary — return the full artifact
- Use the reference and template files in the skill directory

**Required output structure** (so the coordinator can extract metadata without parsing prose):

```
RECOMMENDATION: <verdict>
TICKERS: <ticker>

<full memo or report text>
```

The coordinator reads the first two header lines, strips them, and passes the remaining text to `save_report.py --content` and `send_message`.

---

## Supporting skill

**File:** `container/skills/stock-market-investing-reference/SKILL.md`

Shared background-reference skill both subagents can preload. Contains:
- Global Telegram markdown conventions
- Recommendation/entry-zone taxonomy used across DD and TA
- Paths to scripts and reference files inside the container
- Shared reminders that would otherwise be duplicated in both agent files

Reference-only — no workflow steps.

---

## Infrastructure change

**File:** `src/container-runner.ts`

Add a sync loop for `container/agents/` → `/home/node/.claude/agents/`, identical to the existing skills sync loop. This makes agent definition files available in the container at the path Claude Code recognizes for custom `Task` agents.

No other infrastructure changes.

---

## Migration

1. `SKILL-dd.md` and `SKILL-ta.md` are **not deleted** until the new agents are wired in and verified
2. The new `stock-dd-writer.md` and `stock-technical-analyst.md` agents shadow the old skills once in place
3. `DOCS.md` content is moved to `references/screener-schema.md`; `DOCS.md` is removed after
4. Screener, query, and portfolio sections of `SKILL.md` are **not changed**
5. All existing Python scripts (`due_diligence.py`, `technical_analysis.py`, `save_report.py`, etc.) are **not changed**
6. The `index.ts` code-level delivery path remains as a safety net but is no longer the primary guarantee

---

## Behavioral contracts

| Actor | Responsibility | Explicitly NOT responsible for |
|---|---|---|
| Coordinator (SKILL.md) | Route, invoke subagent, save, deliver, confirm | Analysis logic, formatting decisions |
| DD subagent (stock-dd-writer.md) | Produce complete DD memo + metadata | send_message, save_report.py, delivery |
| TA subagent (stock-technical-analyst.md) | Produce complete TA report + metadata | send_message, save_report.py, delivery |
| Reference files | Support reasoning quality | Any runtime behavior |

---

## Success criteria

- DD: user receives full investment memo via Telegram, report saved to DB
- TA: user receives full technical report via Telegram, report saved to DB
- No regressions in screener, query, or portfolio flows
- Coordinator SKILL.md is short enough to read in under 2 minutes
- Subagent definitions contain no delivery/persistence instructions
