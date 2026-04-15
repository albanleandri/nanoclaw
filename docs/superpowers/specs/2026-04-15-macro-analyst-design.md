# Macro Analyst Agent — Design Spec

**Date:** 2026-04-15
**Status:** Approved

---

## Overview

Adds a standalone macro analyst agent to the stock investment suite. The agent evaluates the current macroeconomic environment, produces a `TAILWIND / NEUTRAL / HEADWIND` verdict, and delivers a structured report via Telegram.

Two invocation modes:

1. **Standalone** — user asks for a macro check (with or without sector context)
2. **DD pre-flight** — coordinator invokes the macro agent before dispatching the DD writer; the macro snapshot is injected into the DD writer's input and rendered as a `🌍 MACRO CONTEXT` section in the investment memo

**Key design decisions:**
- Macro verdict is informational only — it does not affect the DD composite score (0–100)
- The score answers "is this a good company at a good price?" — a durable question. Macro answers "what is the timing environment?" — a separate, faster-changing question
- Analysis logic lives in a dedicated checklist file (`references/macro-analysis-checklist.md`), not in the agent file — safe to evolve over time without touching agent wiring
- Data source: web search, consistent with how the portfolio manager fetches macro context

---

## Data Model

Two-layer analysis, always:

**Layer 1 — Global (always fetched):**
- Fed stance + rate direction (hiking / pausing / cutting)
- 10-year Treasury yield + yield curve shape (normal / flat / inverted)
- VIX (fear index — market volatility / risk appetite)
- USD index (DXY) — strength signals
- CPI trend (inflation direction)

**Layer 2 — Sector-specific (when sector is known):**
- Sector ETF performance vs. S&P 500 (trend)
- Sector-relevant factors (examples: mortgage rates for REITs, oil prices for energy/airlines, AI capex cycle for semiconductors, tariff exposure for industrials, rate sensitivity for financials)
- Key input cost pressures or tailwinds specific to the sector

When invoked standalone without a ticker, Layer 2 covers broad market conditions only.

When invoked as DD pre-flight, the coordinator passes the ticker. The macro agent infers the sector from the ticker via web search (reliable for all major tickers) and runs the full two-layer analysis. It does not wait for the DD data fetch — it is self-contained.

---

## Agent Output Format

The macro agent always starts its response with two header lines (consistent with `stock-dd-writer` and `stock-technical-analyst`):

```
MACRO_VERDICT: <TAILWIND|NEUTRAL|HEADWIND>
SECTOR: <sector_name or GLOBAL>

<full macro report in Telegram markdown>
```

The coordinator reads the headers, strips them, and:
- **Standalone mode:** saves the full report to `reports`, delivers via `send_message`
- **DD pre-flight mode:** injects the report block into the DD writer's input as `MACRO_SNAPSHOT`

---

## Flows

### Standalone invocation

```
User: "macro check" / "macro environment for tech stocks"
Coordinator:
  1. Parse: standalone macro request, optional sector hint
  2. Invoke macro-analyst via Task tool
  3. Parse MACRO_VERDICT + SECTOR headers, strip them
  4. Save to reports (type = "macro_context", tickers = SECTOR or "GLOBAL")
  5. Send full report via send_message
  6. Return short confirmation
```

### DD pre-flight invocation

```
User: "DD on AAPL"
Coordinator:
  1. Ensure ticker in DB (run stock_screener.py if needed)
  2. Invoke macro-analyst via Task tool with "TICKER: AAPL"
  3. Receive macro snapshot (headers + report block)
  4. Invoke stock-dd-writer via Task tool with:
       Ticker: AAPL
       DB: /workspace/group/investments.db
       MACRO_SNAPSHOT: <full macro report block>
  5. Parse RECOMMENDATION + TICKERS from DD writer output
  6. Save DD report, send via send_message
  7. Return short confirmation
```

The macro snapshot is not saved separately in DD pre-flight mode — it is embedded in the DD report content. The DD report is what gets persisted.

---

## Files

### New files

| File | Purpose |
|---|---|
| `container/skills/agents/macro-analyst.md` | Agent definition — thin orchestration only |
| `container/skills/stock-market-investing/references/macro-analysis-checklist.md` | Analysis logic — evolve this file over time to add new indicators |
| `container/skills/stock-market-investing/templates/macro-template.md` | Telegram output format for the macro report |

### Modified files

| File | Change |
|---|---|
| `container/skills/stock-market-investing/SKILL.md` | Add standalone macro trigger + routing rule; update DD section to add pre-flight step |
| `container/skills/agents/stock-dd-writer.md` | Accept optional `MACRO_SNAPSHOT:` block in input; render it as `🌍 MACRO CONTEXT` section between RISKS and BOTTOM LINE; no change to scoring |

### No schema changes

`reports` table already supports arbitrary `report_type` values. Standalone macro reports use `report_type = "macro_context"` with `tickers` set to the sector name or `"GLOBAL"`. No migration needed.

---

## Evolvability

The macro agent file (`macro-analyst.md`) is intentionally thin — it orchestrates steps and delegates reasoning to the checklist. To improve macro analysis over time:

1. **Add indicators:** extend `references/macro-analysis-checklist.md` with new data points (yield curve inversion logic, credit spreads, ISM PMI, etc.)
2. **Add a data script:** create `macro_data.py` to fetch structured indicators (yfinance or FRED API), then update the checklist to call it — same pattern as `due_diligence.py`
3. **Add sector mappings:** extend the checklist with more granular sector → indicator mappings

None of these require touching the agent file or the coordinator wiring.

---

## Behavioral contracts

| Actor | Responsibility | Explicitly NOT responsible for |
|---|---|---|
| Coordinator (SKILL.md) | Route, invoke macro-analyst, inject snapshot into DD writer, save, deliver | Analysis logic |
| macro-analyst | Infer sector from ticker, fetch global + sector indicators, produce structured report | send_message, save_report.py, delivery |
| stock-dd-writer | Accept optional macro snapshot, render it as a section, run 5-lens analysis | Fetching any macro data |

---

## Success criteria

- Standalone: user receives macro report via Telegram, saved to reports table
- DD: investment memo includes `🌍 MACRO CONTEXT` section between RISKS and BOTTOM LINE
- DD composite score is unchanged — macro verdict does not alter the 0–100 score
- Macro agent is independently invocable with or without a ticker
- `macro-analysis-checklist.md` can be extended without touching any other file
