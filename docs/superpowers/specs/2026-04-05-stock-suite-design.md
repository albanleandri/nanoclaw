# Stock Investment Suite — Design Spec

**Date:** 2026-04-05
**Status:** Approved

## Overview

Extends the existing stock screener system with three new capabilities that complete the full investment workflow:

1. **Due Diligence** (`due_diligence.py`) — structured investment memo for shortlisted stocks
2. **Technical Analysis** (`technical_analysis.py`) — entry point assessment using classic indicators
3. **Portfolio Manager** (`portfolio_manager.py`) — on-demand portfolio review with news/macro context

**Core principle:** Thin Python scripts handle quantitative computation only. The Claude agent does web search, qualitative synthesis, and narrative generation. All recommendations are persisted to the DB for historical reference.

Each capability is independently invocable. No automatic chaining — the user decides when to advance from one step to the next (manual handoff).

---

## Database

### Rename: `stock_screener.db` → `investments.db`

A `migrate_db.py` script handles the rename at startup: if `stock_screener.db` exists and `investments.db` does not, rename it. All three new scripts call this at startup. Existing scripts get a one-line default path update. Silent no-op if already migrated.

### New Table: `portfolio_holdings`

One row per position. Managed conversationally by the agent.

```sql
CREATE TABLE portfolio_holdings (
    ticker          TEXT PRIMARY KEY,
    shares          REAL NOT NULL,
    avg_buy_price   REAL NOT NULL,
    buy_date        TEXT NOT NULL,       -- ISO 8601
    currency        TEXT DEFAULT 'USD',
    notes           TEXT,               -- optional thesis note
    last_updated    TEXT NOT NULL        -- ISO 8601 UTC
);
```

### New Table: `reports`

Persists every recommendation the agent generates. Enables historical queries ("what did you recommend for AAPL last month?") and lets the portfolio manager reference prior DD scores.

```sql
CREATE TABLE reports (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    report_type     TEXT NOT NULL,   -- due_diligence | technical | portfolio_review
    tickers         TEXT NOT NULL,   -- comma-separated
    generated_at    TEXT NOT NULL,   -- ISO 8601 UTC
    recommendation  TEXT,            -- buy | hold | sell | watch | entry_now | wait
    content         TEXT NOT NULL,   -- full narrative report (Telegram markdown)
    agent_notes     TEXT             -- optional free-form follow-up
);
```

---

## Script 1: `due_diligence.py`

### Purpose

Fetches comprehensive fundamental data for one or more tickers and outputs a structured JSON blob. The agent then applies the DD skill framework to produce the investment memo.

### Invocation

```bash
python3 due_diligence.py --tickers AAPL MSFT --db /workspace/group/investments.db
```

### Data Sources

**From existing DB** (`companies`, `prices`, `annual_financials`): valuation ratios, margins, ROIC, FCF, Piotroski F-Score, Altman Z, CAGRs, debt metrics.

**Supplementary Yahoo Finance fetch** (fields not currently stored in DB): uses the same `curl_cffi` browser-impersonation session and exponential backoff pattern as `stock_screener.py` to avoid 429 rate limits.

| Field group | Yahoo Finance module |
|---|---|
| Business description | `assetProfile` |
| Analyst targets (mean/low/high, # analysts, recommendation) | `financialData` |
| Ownership (insider %, institutional %, short ratio, short % of float) | `majorHoldersBreakdown`, `defaultKeyStatistics` |
| Insider transactions (recent buys/sells with names and amounts) | `insiderTransactions` |

### Output JSON Schema

```json
{
  "ticker": "AAPL",
  "identification": {
    "name": "Apple Inc.", "sector": "Technology", "industry": "Consumer Electronics",
    "market_cap": 2850000000000, "enterprise_value": 2900000000000,
    "description": "Apple designs and markets consumer electronics..."
  },
  "price": {
    "current": 192.3, "52w_high": 199.6, "52w_low": 164.1,
    "sma_50": 185.2, "sma_200": 178.4, "beta": 1.24
  },
  "valuation": {
    "pe_trailing": 31.2, "pe_forward": 27.8, "peg_ratio": 2.1,
    "price_to_book": 8.4, "price_to_sales": 7.6, "ev_to_ebitda": 22.1,
    "price_to_fcf": 28.4
  },
  "profitability": {
    "gross_margin": 0.458, "operating_margin": 0.312, "net_margin": 0.254,
    "roe": 1.47, "roa": 0.28, "roic": 0.54
  },
  "health": {
    "total_debt": 104000000000, "total_cash": 67000000000,
    "debt_to_equity": 1.51, "current_ratio": 1.07,
    "free_cash_flow": 99500000000, "operating_cash_flow": 113000000000
  },
  "growth": {
    "revenue_growth": 0.024, "earnings_growth": 0.11,
    "trailing_eps": 6.13, "forward_eps": 6.92,
    "revenue_cagr_3y": 0.082
  },
  "dividends": { "dividend_yield": 0.0052, "payout_ratio": 0.156 },
  "analysts": {
    "target_mean": 210.5, "target_low": 185.0, "target_high": 240.0,
    "recommendation": "buy", "num_analysts": 38
  },
  "ownership": {
    "insider_pct": 0.028, "institutional_pct": 0.612,
    "short_ratio": 1.2, "short_pct_of_float": 0.008
  },
  "insider_transactions": [
    { "date": "2026-03-15", "name": "Tim Cook", "type": "sell", "shares": 50000, "value": 9600000 }
  ],
  "historical": {
    "annual": [
      { "year": "2025", "revenue": 391000000000, "net_income": 93700000000, "fcf": 99500000000 }
    ]
  },
  "red_flags": ["Insider selling by CEO", "Revenue growth slowing (2.4% YoY)"],
  "piotroski_f": 7,
  "altman_z": 3.8
}
```

### Agent Workflow

1. Run `due_diligence.py` → receive JSON
2. Apply DD skill framework (5-lens analysis + 0–100 composite score)
3. Web-search for recent news/events for each ticker
4. Synthesize into Telegram-formatted investment memo
5. Save to `reports` (`report_type = "due_diligence"`)

---

## Script 2: `technical_analysis.py`

### Purpose

Fetches 2 years of daily OHLCV price history and computes technical indicators, producing a structured JSON entry-point assessment.

### Invocation

```bash
python3 technical_analysis.py --tickers AAPL MSFT --db /workspace/group/investments.db --horizon 2w
```

`--horizon` accepts: `1w`, `2w`, `1m`, `3m`. Defaults to `2w`.

### Data Source

`yfinance.download(ticker, period="2y", interval="1d")` — transient, not stored in DB.

### Indicators

| Indicator | Parameters | Signal used |
|---|---|---|
| SMA | 50-day, 200-day | Trend direction; golden/death cross |
| EMA | 20-day, 50-day | Faster trend, momentum |
| RSI | 14-day | Overbought >70 / oversold <30 |
| MACD | 12/26/9 | Momentum; bullish/bearish crossover |
| Bollinger Bands | 20-day, 2σ | Price extremes, volatility |
| Volume trend | 20-day avg vs current | Confirms or questions price moves |
| 52-week positioning | % from high/low | Margin of safety context |
| ATR | 14-day | For stop-loss sizing |

### Horizon Context

- **Short (1–2w):** RSI and MACD crossovers dominate — is momentum aligned for immediate entry?
- **Medium (1–3m):** MA positioning and Bollinger Band location matter more — is price near a mean-reversion zone?

### Output JSON Schema

```json
{
  "ticker": "AAPL",
  "horizon": "2w",
  "entry_zone": "wait_for_pullback",
  "key_levels": { "support": 171.20, "resistance": 182.50 },
  "indicators": {
    "rsi_14": 67.3,
    "macd": { "macd": 2.14, "signal": 1.87, "histogram": 0.27, "crossover": "bullish" },
    "sma_50": 178.4, "sma_200": 171.2,
    "ema_20": 180.1, "ema_50": 176.3,
    "bollinger": { "upper": 188.5, "mid": 180.0, "lower": 171.5, "position": "upper_half" },
    "volume_vs_avg": 0.94,
    "atr_14": 3.21,
    "pct_from_52w_high": -0.037,
    "pct_from_52w_low": 0.171,
    "golden_cross": true,
    "death_cross": false
  },
  "summary": "Price near upper Bollinger Band with RSI approaching overbought (67). MACD bullish but losing momentum. For a 2-week horizon, wait for a pullback to the 50-day EMA (~$178) before entering. Support at $171."
}
```

`entry_zone` values: `entry_now` | `wait_for_pullback` | `overbought_avoid` | `oversold_watch`

### Agent Workflow

1. Run `technical_analysis.py` → receive JSON
2. Synthesize into Telegram-formatted entry-point memo
3. Save to `reports` (`report_type = "technical"`)

---

## Script 3: `portfolio_manager.py`

### Purpose

Reads portfolio holdings from DB, joins with current prices and fundamentals, and outputs a structured performance + thesis-health JSON. The agent enriches with news and macro context before generating the review.

### Invocation

```bash
python3 portfolio_manager.py --db /workspace/group/investments.db
```

### Computation

**Per holding** (joined from `portfolio_holdings` + `prices` + `annual_financials`):

| Metric | Calculation |
|---|---|
| Unrealized gain/loss | `(current_price - avg_buy_price) × shares` |
| Return % | `(current_price / avg_buy_price - 1) × 100` |
| Days held | `today - buy_date` |
| Thesis flags | ROIC dropped >3pts, margins compressed >3pts, net debt surged >50% since purchase |
| Prior DD score | Latest score from `reports` table where `report_type = "due_diligence"` for this ticker |

**Portfolio-level:**
- Total invested, current value, overall return %
- Sector allocation (% of portfolio by current value)
- Concentration warning if any holding > 20% of portfolio
- Holdings sorted by return % descending

### Output JSON Schema

```json
{
  "portfolio_summary": {
    "total_invested": 45000, "current_value": 51200,
    "return_pct": 13.8, "return_abs": 6200
  },
  "holdings": [
    {
      "ticker": "AAPL", "shares": 50, "avg_buy_price": 175.0, "buy_date": "2025-01-15",
      "current_price": 192.3, "return_pct": 9.9, "return_abs": 865, "days_held": 445,
      "sector": "Technology", "weight_pct": 18.8,
      "thesis_flags": ["ROIC stable at 54%", "margins expanding"],
      "thesis_concerns": [],
      "prior_dd_score": 78, "prior_dd_date": "2025-01-10"
    }
  ],
  "sector_allocation": { "Technology": 0.62, "Healthcare": 0.38 },
  "concentration_warnings": [],
  "winners": ["NVDA", "MSFT"],
  "losers": ["INTC"]
}
```

### Agent Workflow

1. Run `portfolio_manager.py` → receive JSON
2. Web-search recent news for each holding (past 2 weeks)
3. Fetch macro context: 10-year Treasury yield, VIX, relevant sector ETF performance
4. For each holding: `HOLD` / `TRIM` / `ADD` / `EXIT` with one-line rationale
5. Save full review to `reports` (`report_type = "portfolio_review"`)

### Holdings Management (Conversational)

The agent writes directly to `portfolio_holdings` based on natural language:

| User says | Agent action |
|---|---|
| "I bought 50 AAPL at $175 on Jan 15" | INSERT or UPDATE |
| "I sold 20 AAPL at $192" | Reduce shares; DELETE if fully exited |
| "Show my portfolio" | Run script, display summary only (no full review) |
| "Review my portfolio" | Run script + full agent enrichment + save to reports |

---

## Script 4: `migrate_db.py`

Small utility called at startup by all three new scripts.

```python
def migrate_db(db_dir: Path) -> Path:
    old = db_dir / "stock_screener.db"
    new = db_dir / "investments.db"
    if old.exists() and not new.exists():
        old.rename(new)
    return new
```

All existing scripts (`stock_screener.py`, `query_stocks.py`, `market_tickers.py`) get their default `--db` path updated from `stock_screener.db` to `investments.db`.

---

## SKILL.md Updates

The existing `container/skills/stock-screener/SKILL.md` gets a new section documenting triggers for the three new capabilities:

**Due diligence:** "DD on AAPL", "analyze TSLA", "should I buy MSFT?", "investment memo for GOOG", "research X"

**Technical analysis:** "technical entry for AAPL", "is now a good time to buy NVDA?", "entry point for TSLA in the next 2 weeks", "chart MSFT"

**Portfolio:** "show my portfolio", "review my portfolio", "how are my holdings doing?", "I bought/sold X shares of TICKER at $PRICE on DATE", "add TICKER to my portfolio"

**Past reports:** "show my last DD on AAPL", "what did you recommend for TSLA last month?"

A separate `SKILL-dd.md` file contains the full DD analysis framework (5-lens, scoring rubric, output format) that the agent loads when running due diligence.

---

## File Structure Summary

```
container/skills/stock-screener/
├── stock_screener.py        [existing — update default db path]
├── query_stocks.py          [existing — update default db path]
├── market_tickers.py        [existing — no change]
├── due_diligence.py         [NEW]
├── technical_analysis.py    [NEW]
├── portfolio_manager.py     [NEW]
├── migrate_db.py            [NEW]
├── SKILL.md                 [existing — add new command triggers]
├── SKILL-dd.md              [NEW — DD analysis framework]
└── DOCS.md                  [existing — update schema with new tables]
```

---

## Out of Scope

- Scheduled runs (portfolio manager is on-demand for now; scheduling can be added later via NanoClaw's task scheduler)
- Automatic pipeline chaining (manual handoff between steps)
- Price history storage in DB (technical analysis fetches transiently)
- Multiple portfolios (single portfolio per group DB)
