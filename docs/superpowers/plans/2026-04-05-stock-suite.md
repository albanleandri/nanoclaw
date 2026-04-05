# Stock Investment Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add due diligence, technical analysis, and portfolio manager capabilities to the existing stock screener, completing the full investment workflow.

**Architecture:** Three thin Python scripts (`due_diligence.py`, `technical_analysis.py`, `portfolio_manager.py`) produce structured JSON from quantitative data; the Claude agent handles web search, synthesis, and narrative generation. A shared `migrate_db.py` handles the DB rename (`stock_screener.db` → `investments.db`) and creates two new tables (`portfolio_holdings`, `reports`).

**Tech Stack:** Python 3, SQLite3, yfinance, pandas, curl_cffi (already installed), pytest

**Spec:** `docs/superpowers/specs/2026-04-05-stock-suite-design.md`

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Create | `container/skills/stock-screener/migrate_db.py` | DB file rename + new table creation |
| Create | `container/skills/stock-screener/test_migrate_db.py` | Tests for migrate_db |
| Create | `container/skills/stock-screener/due_diligence.py` | DD data extraction → JSON |
| Create | `container/skills/stock-screener/test_due_diligence.py` | Tests for due_diligence |
| Create | `container/skills/stock-screener/technical_analysis.py` | Indicator computation → JSON |
| Create | `container/skills/stock-screener/test_technical_analysis.py` | Tests for technical_analysis |
| Create | `container/skills/stock-screener/portfolio_manager.py` | Holdings CRUD + portfolio computation → JSON |
| Create | `container/skills/stock-screener/test_portfolio_manager.py` | Tests for portfolio_manager |
| Create | `container/skills/stock-screener/SKILL-dd.md` | DD analysis framework skill file |
| Modify | `container/skills/stock-screener/SKILL.md` | Add new command triggers |
| Modify | `container/skills/stock-screener/DOCS.md` | Document new DB tables |
| Modify | `container/skills/stock-screener/stock_screener.py:206` | Update DEFAULT_DB path |
| Modify | `container/skills/stock-screener/query_stocks.py:22` | Update DEFAULT_DB path |

---

## Task 1: DB Migration — `migrate_db.py`

**Files:**
- Create: `container/skills/stock-screener/migrate_db.py`
- Create: `container/skills/stock-screener/test_migrate_db.py`

- [ ] **Step 1: Write the failing tests**

Create `container/skills/stock-screener/test_migrate_db.py`:

```python
"""Tests for migrate_db.py"""
import sqlite3
import sys
import os
from pathlib import Path
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import migrate_db as mdb


def test_migrate_db_file_renames(tmp_path):
    old = tmp_path / "stock_screener.db"
    old.touch()
    result = mdb.migrate_db_file(tmp_path)
    assert result == tmp_path / "investments.db"
    assert (tmp_path / "investments.db").exists()
    assert not old.exists()


def test_migrate_db_file_noop_if_new_exists(tmp_path):
    old = tmp_path / "stock_screener.db"
    new = tmp_path / "investments.db"
    old.write_text("old")
    new.write_text("new")
    mdb.migrate_db_file(tmp_path)
    assert new.read_text() == "new"
    assert old.exists()


def test_migrate_db_file_noop_if_old_missing(tmp_path):
    result = mdb.migrate_db_file(tmp_path)
    assert result == tmp_path / "investments.db"
    assert not result.exists()


def test_ensure_new_tables_creates_tables(tmp_path):
    conn = sqlite3.connect(tmp_path / "test.db")
    mdb.ensure_new_tables(conn)
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    assert "portfolio_holdings" in tables
    assert "reports" in tables
    conn.close()


def test_ensure_new_tables_idempotent(tmp_path):
    conn = sqlite3.connect(tmp_path / "test.db")
    mdb.ensure_new_tables(conn)
    mdb.ensure_new_tables(conn)  # must not raise
    conn.close()


def test_portfolio_holdings_schema(tmp_path):
    conn = sqlite3.connect(tmp_path / "test.db")
    mdb.ensure_new_tables(conn)
    conn.execute("""
        INSERT INTO portfolio_holdings
            (ticker, shares, avg_buy_price, buy_date, last_updated)
        VALUES ('AAPL', 50.0, 175.0, '2025-01-15', '2026-04-05T00:00:00+00:00')
    """)
    row = conn.execute(
        "SELECT ticker, shares, avg_buy_price, currency FROM portfolio_holdings WHERE ticker='AAPL'"
    ).fetchone()
    assert row == ('AAPL', 50.0, 175.0, 'USD')
    conn.close()


def test_reports_schema(tmp_path):
    conn = sqlite3.connect(tmp_path / "test.db")
    mdb.ensure_new_tables(conn)
    conn.execute("""
        INSERT INTO reports (report_type, tickers, generated_at, recommendation, content)
        VALUES ('due_diligence', 'AAPL', '2026-04-05T00:00:00+00:00', 'buy', 'Test report')
    """)
    row = conn.execute(
        "SELECT report_type, tickers, recommendation FROM reports"
    ).fetchone()
    assert row == ('due_diligence', 'AAPL', 'buy')
    conn.close()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/nanoclaw/nanoclaw
python3 -m pytest container/skills/stock-screener/test_migrate_db.py -v
```

Expected: `ModuleNotFoundError: No module named 'migrate_db'`

- [ ] **Step 3: Write the implementation**

Create `container/skills/stock-screener/migrate_db.py`:

```python
#!/usr/bin/env python3
"""migrate_db.py — DB file rename and new-table migration for the stock investment suite.

Called at startup by due_diligence.py, technical_analysis.py, and portfolio_manager.py.
Safe to call multiple times (idempotent).
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

NEW_TABLES = """
CREATE TABLE IF NOT EXISTS portfolio_holdings (
    ticker          TEXT PRIMARY KEY,
    shares          REAL NOT NULL,
    avg_buy_price   REAL NOT NULL,
    buy_date        TEXT NOT NULL,
    currency        TEXT NOT NULL DEFAULT 'USD',
    notes           TEXT,
    last_updated    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    report_type     TEXT NOT NULL,
    tickers         TEXT NOT NULL,
    generated_at    TEXT NOT NULL,
    recommendation  TEXT,
    content         TEXT NOT NULL,
    agent_notes     TEXT
);
"""


def migrate_db_file(db_dir: Path) -> Path:
    """Rename stock_screener.db → investments.db in *db_dir* if needed.

    Returns the path to investments.db (whether or not a rename occurred).
    """
    old = db_dir / "stock_screener.db"
    new = db_dir / "investments.db"
    if old.exists() and not new.exists():
        old.rename(new)
    return new


def ensure_new_tables(conn: sqlite3.Connection) -> None:
    """Create portfolio_holdings and reports tables if they don't exist."""
    conn.executescript(NEW_TABLES)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python3 -m pytest container/skills/stock-screener/test_migrate_db.py -v
```

Expected: 7 PASSED

- [ ] **Step 5: Commit**

```bash
git add container/skills/stock-screener/migrate_db.py container/skills/stock-screener/test_migrate_db.py
git commit -m "feat(stock-suite): add migrate_db — DB rename and new tables"
```

---

## Task 2: Due Diligence — DB Fundamentals Extraction

**Files:**
- Create: `container/skills/stock-screener/due_diligence.py` (partial)
- Create: `container/skills/stock-screener/test_due_diligence.py` (partial)

- [ ] **Step 1: Write the failing tests**

Create `container/skills/stock-screener/test_due_diligence.py`:

```python
"""Tests for due_diligence.py"""
import json
import sqlite3
import sys
import os
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import due_diligence as dd


# ── DB fixture ────────────────────────────────────────────────────────────────

def make_test_db(tmp_path: Path) -> sqlite3.Connection:
    """Create a minimal investments.db with one ticker for testing."""
    db = tmp_path / "investments.db"
    conn = sqlite3.connect(db)
    conn.executescript("""
        CREATE TABLE companies (
            ticker TEXT PRIMARY KEY, name TEXT, sector TEXT, industry TEXT,
            currency TEXT, country TEXT, shares_outstanding INTEGER, beta REAL,
            last_updated TEXT NOT NULL
        );
        CREATE TABLE prices (
            ticker TEXT PRIMARY KEY, price REAL, market_cap REAL,
            trailing_pe REAL, forward_pe REAL, price_to_book REAL,
            enterprise_value REAL, trailing_eps REAL, dividend_yield REAL,
            peg_ratio REAL, ev_ebitda REAL,
            fifty_two_week_high REAL, fifty_two_week_low REAL,
            price_to_fcf REAL, fetched_at TEXT NOT NULL
        );
        CREATE TABLE annual_financials (
            ticker TEXT NOT NULL, period_end TEXT NOT NULL,
            revenue REAL, gross_profit REAL, operating_income REAL,
            net_income REAL, free_cashflow REAL, operating_cashflow REAL,
            total_debt REAL, cash_equiv REAL, total_equity REAL,
            total_assets REAL, current_assets REAL, current_liabilities REAL,
            gross_margin REAL, operating_margin REAL, net_margin REAL,
            roe REAL, roa REAL, roic REAL, current_ratio REAL,
            net_debt REAL, ebitda REAL, piotroski_f INTEGER, altman_z REAL,
            accruals_ratio REAL, cash_conversion REAL,
            revenue_cagr_3y REAL, revenue_cagr_5y REAL,
            PRIMARY KEY (ticker, period_end)
        );
    """)
    now = "2026-04-05T00:00:00+00:00"
    conn.execute("""
        INSERT INTO companies VALUES
        ('AAPL','Apple Inc.','Technology','Consumer Electronics','USD','US',15e9,1.24,?)
    """, (now,))
    conn.execute("""
        INSERT INTO prices VALUES
        ('AAPL',192.3,2.85e12,31.2,27.8,8.4,2.9e12,6.13,0.0052,2.1,22.1,199.6,164.1,28.4,?)
    """, (now,))
    for i, year in enumerate(["2025-09-30", "2024-09-30", "2023-09-30", "2022-09-30"]):
        conn.execute("""
            INSERT INTO annual_financials
            (ticker, period_end, revenue, gross_profit, operating_income, net_income,
             free_cashflow, operating_cashflow, total_debt, cash_equiv, total_equity,
             total_assets, current_assets, current_liabilities,
             gross_margin, operating_margin, net_margin,
             roe, roa, roic, current_ratio, net_debt, ebitda,
             piotroski_f, altman_z, accruals_ratio, cash_conversion,
             revenue_cagr_3y, revenue_cagr_5y)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, ('AAPL', year,
              391e9 - i*10e9, 179e9 - i*5e9, 121e9 - i*4e9, 93.7e9 - i*3e9,
              99.5e9 - i*3e9, 113e9 - i*3e9, 104e9, 67e9, 62e9, 352e9,
              152e9, 133e9, 0.458, 0.312, 0.254, 1.47, 0.28, 0.54, 1.07,
              37e9, 130e9, 7, 3.8, 0.02, 1.06, 0.082, 0.091))
    conn.commit()
    return conn


# ── Tests for _read_db_fundamentals ──────────────────────────────────────────

def test_read_db_fundamentals_returns_expected_keys(tmp_path):
    conn = make_test_db(tmp_path)
    result = dd._read_db_fundamentals(conn, "AAPL")
    assert result["ticker"] == "AAPL"
    assert result["identification"]["name"] == "Apple Inc."
    assert result["identification"]["sector"] == "Technology"
    assert result["price"]["current"] == 192.3
    assert result["valuation"]["pe_trailing"] == 31.2
    assert result["profitability"]["gross_margin"] == pytest.approx(0.458)
    assert result["health"]["total_debt"] == pytest.approx(104e9)
    assert len(result["historical"]["annual"]) == 4
    conn.close()


def test_read_db_fundamentals_unknown_ticker(tmp_path):
    conn = make_test_db(tmp_path)
    result = dd._read_db_fundamentals(conn, "ZZZZ")
    assert result is None
    conn.close()


def test_read_db_fundamentals_historical_sorted_desc(tmp_path):
    conn = make_test_db(tmp_path)
    result = dd._read_db_fundamentals(conn, "AAPL")
    years = [r["period_end"] for r in result["historical"]["annual"]]
    assert years == sorted(years, reverse=True)
    conn.close()


def test_read_db_fundamentals_price_to_fcf(tmp_path):
    conn = make_test_db(tmp_path)
    result = dd._read_db_fundamentals(conn, "AAPL")
    assert result["valuation"]["price_to_fcf"] == pytest.approx(28.4)
    conn.close()


def test_read_db_fundamentals_piotroski_altman(tmp_path):
    conn = make_test_db(tmp_path)
    result = dd._read_db_fundamentals(conn, "AAPL")
    assert result["piotroski_f"] == 7
    assert result["altman_z"] == pytest.approx(3.8)
    conn.close()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python3 -m pytest container/skills/stock-screener/test_due_diligence.py::test_read_db_fundamentals_returns_expected_keys -v
```

Expected: `ModuleNotFoundError: No module named 'due_diligence'`

- [ ] **Step 3: Write the DB extraction function**

Create `container/skills/stock-screener/due_diligence.py`:

```python
#!/usr/bin/env python3
"""due_diligence.py — fetch DD data for tickers and output JSON for agent analysis.

Usage:
    python3 due_diligence.py --tickers AAPL MSFT [--db PATH]

Outputs a JSON array to stdout. One object per ticker with fundamentals from
the local DB merged with supplementary fields from Yahoo Finance (analyst targets,
ownership, insider transactions, business description).
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
import random
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

try:
    from curl_cffi import requests as _curl_requests
    _CURL_IMPERSONATE = "chrome124"
except ImportError:
    _curl_requests = None  # type: ignore[assignment]

DEFAULT_DB = Path("/workspace/group/investments.db")

_QS_URL = "https://query2.finance.yahoo.com/v10/finance/quoteSummary/{ticker}"
_QS_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
}
_QS_TIMEOUT_INIT = 15
_QS_TIMEOUT_DATA = 30
_MAX_429_RETRIES  = 3
_429_BACKOFF_SECS = [30, 60, 90]

_DD_MODULES = ",".join([
    "assetProfile",
    "financialData",
    "majorHoldersBreakdown",
    "defaultKeyStatistics",
    "insiderTransactions",
])

_HTTP_ERRORS: tuple = (requests.exceptions.HTTPError,)
if _curl_requests is not None:
    _HTTP_ERRORS = _HTTP_ERRORS + (_curl_requests.exceptions.HTTPError,)

_qs_session: Optional[Any] = None
_qs_crumb:   Optional[str] = None


def _new_http_session() -> Any:
    if _curl_requests is not None:
        return _curl_requests.Session(impersonate=_CURL_IMPERSONATE)
    s = requests.Session()
    s.headers.update(_QS_HEADERS)
    return s


def _ensure_qs_session() -> Tuple[Any, str]:
    global _qs_session, _qs_crumb
    if _qs_session is None or _qs_crumb is None:
        session = _new_http_session()
        session.get("https://finance.yahoo.com/", timeout=_QS_TIMEOUT_INIT)
        crumb_resp = session.get(
            "https://query2.finance.yahoo.com/v1/test/getcrumb",
            timeout=_QS_TIMEOUT_INIT,
        )
        crumb_resp.raise_for_status()
        _qs_session = session
        _qs_crumb   = crumb_resp.text.strip()
    return _qs_session, _qs_crumb


def _safe_float(v: Any) -> Optional[float]:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _safe_qs(module: dict, key: str) -> Optional[float]:
    val = module.get(key)
    if isinstance(val, dict):
        return _safe_float(val.get("raw"))
    return _safe_float(val)


def _read_db_fundamentals(conn: sqlite3.Connection, ticker: str) -> Optional[Dict]:
    """Read all available fundamentals for *ticker* from the investments DB.

    Returns a structured dict matching the DD JSON schema, or None if the
    ticker is not found in the companies table.
    """
    row = conn.execute(
        "SELECT ticker, name, sector, industry, currency, country FROM companies WHERE ticker=?",
        (ticker,)
    ).fetchone()
    if row is None:
        return None

    ticker, name, sector, industry, currency, country = row

    price_row = conn.execute(
        """SELECT price, market_cap, trailing_pe, forward_pe, price_to_book,
                  enterprise_value, trailing_eps, dividend_yield, peg_ratio,
                  ev_ebitda, fifty_two_week_high, fifty_two_week_low, price_to_fcf
           FROM prices WHERE ticker=?""",
        (ticker,)
    ).fetchone()
    p = price_row or ([None] * 13)

    annual_rows = conn.execute(
        """SELECT period_end, revenue, gross_profit, operating_income, net_income,
                  free_cashflow, operating_cashflow, total_debt, cash_equiv,
                  total_equity, total_assets, current_assets, current_liabilities,
                  gross_margin, operating_margin, net_margin,
                  roe, roa, roic, current_ratio, net_debt, ebitda,
                  piotroski_f, altman_z, accruals_ratio, cash_conversion,
                  revenue_cagr_3y, revenue_cagr_5y
           FROM annual_financials WHERE ticker=?
           ORDER BY period_end DESC LIMIT 5""",
        (ticker,)
    ).fetchall()

    latest = dict(zip(
        ["period_end","revenue","gross_profit","operating_income","net_income",
         "free_cashflow","operating_cashflow","total_debt","cash_equiv",
         "total_equity","total_assets","current_assets","current_liabilities",
         "gross_margin","operating_margin","net_margin","roe","roa","roic",
         "current_ratio","net_debt","ebitda","piotroski_f","altman_z",
         "accruals_ratio","cash_conversion","revenue_cagr_3y","revenue_cagr_5y"],
        annual_rows[0]
    )) if annual_rows else {}

    annual_history = []
    for ar in annual_rows:
        keys = ["period_end","revenue","gross_profit","operating_income","net_income",
                "free_cashflow","operating_cashflow","total_debt","cash_equiv",
                "total_equity","total_assets","current_assets","current_liabilities",
                "gross_margin","operating_margin","net_margin","roe","roa","roic",
                "current_ratio","net_debt","ebitda","piotroski_f","altman_z",
                "accruals_ratio","cash_conversion","revenue_cagr_3y","revenue_cagr_5y"]
        annual_history.append(dict(zip(keys, ar)))

    return {
        "ticker": ticker,
        "identification": {
            "name": name, "sector": sector, "industry": industry,
            "currency": currency, "country": country,
            "market_cap": p[1], "enterprise_value": p[5],
            "description": None,  # filled by supplementary fetch
        },
        "price": {
            "current": p[0],
            "52w_high": p[10], "52w_low": p[11],
            "beta": None,
        },
        "valuation": {
            "pe_trailing": p[2], "pe_forward": p[3],
            "peg_ratio": p[8], "price_to_book": p[4],
            "ev_to_ebitda": p[9], "price_to_fcf": p[12],
            "trailing_eps": p[6], "forward_eps": None,
        },
        "profitability": {
            "gross_margin": latest.get("gross_margin"),
            "operating_margin": latest.get("operating_margin"),
            "net_margin": latest.get("net_margin"),
            "roe": latest.get("roe"),
            "roa": latest.get("roa"),
            "roic": latest.get("roic"),
        },
        "health": {
            "total_debt": latest.get("total_debt"),
            "total_cash": latest.get("cash_equiv"),
            "current_ratio": latest.get("current_ratio"),
            "free_cash_flow": latest.get("free_cashflow"),
            "operating_cash_flow": latest.get("operating_cashflow"),
            "net_debt": latest.get("net_debt"),
        },
        "growth": {
            "revenue_cagr_3y": latest.get("revenue_cagr_3y"),
            "revenue_cagr_5y": latest.get("revenue_cagr_5y"),
            "trailing_eps": p[6],
            "forward_eps": None,  # filled by supplementary fetch
        },
        "dividends": {
            "dividend_yield": p[7],
            "payout_ratio": None,
        },
        "analysts": None,      # filled by supplementary fetch
        "ownership": None,     # filled by supplementary fetch
        "insider_transactions": None,  # filled by supplementary fetch
        "historical": {"annual": annual_history},
        "piotroski_f": latest.get("piotroski_f"),
        "altman_z": latest.get("altman_z"),
        "red_flags": [],  # populated by agent using DD skill framework
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python3 -m pytest container/skills/stock-screener/test_due_diligence.py -v
```

Expected: 5 PASSED

- [ ] **Step 5: Commit**

```bash
git add container/skills/stock-screener/due_diligence.py container/skills/stock-screener/test_due_diligence.py
git commit -m "feat(stock-suite): add due_diligence DB extraction + tests"
```

---

## Task 3: Due Diligence — Yahoo Finance Supplementary Fetch

**Files:**
- Modify: `container/skills/stock-screener/due_diligence.py` (add supplementary fetch)
- Modify: `container/skills/stock-screener/test_due_diligence.py` (add fetch tests)

- [ ] **Step 1: Write the failing tests**

Append to `container/skills/stock-screener/test_due_diligence.py`:

```python
# ── Tests for _fetch_supplementary ───────────────────────────────────────────

def _make_supplementary_payload() -> dict:
    """Minimal Yahoo Finance quoteSummary payload for DD modules."""
    return {
        "assetProfile": {
            "longBusinessSummary": "Apple designs consumer electronics.",
        },
        "financialData": {
            "targetMeanPrice":      {"raw": 210.5},
            "targetHighPrice":      {"raw": 240.0},
            "targetLowPrice":       {"raw": 185.0},
            "numberOfAnalystOpinions": {"raw": 38},
            "recommendationKey":    "buy",
            "forwardEps":           {"raw": 6.92},
        },
        "majorHoldersBreakdown": {
            "insidersPercentHeld":      {"raw": 0.028},
            "institutionsPercentHeld":  {"raw": 0.612},
        },
        "defaultKeyStatistics": {
            "shortRatio":           {"raw": 1.2},
            "shortPercentOfFloat":  {"raw": 0.008},
            "beta":                 {"raw": 1.24},
        },
        "insiderTransactions": {
            "transactions": [
                {
                    "filerName": "Tim Cook",
                    "transactionDate": {"fmt": "2026-03-15"},
                    "transactionText": "Sale",
                    "shares": {"raw": 50000},
                    "value": {"raw": 9600000},
                }
            ]
        },
    }


def test_fetch_supplementary_returns_expected_fields():
    payload = _make_supplementary_payload()
    with patch("due_diligence._fetch_dd_quotesummary", return_value=payload):
        result = dd._fetch_supplementary("AAPL")
    assert result["description"] == "Apple designs consumer electronics."
    assert result["analysts"]["target_mean"] == pytest.approx(210.5)
    assert result["analysts"]["target_low"] == pytest.approx(185.0)
    assert result["analysts"]["target_high"] == pytest.approx(240.0)
    assert result["analysts"]["num_analysts"] == 38
    assert result["analysts"]["recommendation"] == "buy"
    assert result["analysts"]["forward_eps"] == pytest.approx(6.92)
    assert result["ownership"]["insider_pct"] == pytest.approx(0.028)
    assert result["ownership"]["institutional_pct"] == pytest.approx(0.612)
    assert result["ownership"]["short_ratio"] == pytest.approx(1.2)
    assert result["ownership"]["short_pct_of_float"] == pytest.approx(0.008)
    assert result["beta"] == pytest.approx(1.24)
    assert len(result["insider_transactions"]) == 1
    txn = result["insider_transactions"][0]
    assert txn["name"] == "Tim Cook"
    assert txn["type"] == "sell"
    assert txn["shares"] == 50000


def test_fetch_supplementary_handles_missing_modules():
    with patch("due_diligence._fetch_dd_quotesummary", return_value={}):
        result = dd._fetch_supplementary("AAPL")
    assert result["description"] is None
    assert result["analysts"] is None
    assert result["ownership"] is None
    assert result["insider_transactions"] == []


def test_fetch_supplementary_handles_network_error():
    with patch("due_diligence._fetch_dd_quotesummary", side_effect=Exception("network error")):
        result = dd._fetch_supplementary("AAPL")
    assert result["description"] is None
    assert result["analysts"] is None


def test_merge_supplementary_fills_none_fields(tmp_path):
    conn = make_test_db(tmp_path)
    base = dd._read_db_fundamentals(conn, "AAPL")
    conn.close()
    supplementary = {
        "description": "Apple designs consumer electronics.",
        "analysts": {"target_mean": 210.5, "target_low": 185.0, "target_high": 240.0,
                     "num_analysts": 38, "recommendation": "buy", "forward_eps": 6.92},
        "ownership": {"insider_pct": 0.028, "institutional_pct": 0.612,
                      "short_ratio": 1.2, "short_pct_of_float": 0.008},
        "insider_transactions": [],
        "beta": 1.24,
    }
    result = dd._merge_supplementary(base, supplementary)
    assert result["identification"]["description"] == "Apple designs consumer electronics."
    assert result["analysts"]["target_mean"] == pytest.approx(210.5)
    assert result["ownership"]["insider_pct"] == pytest.approx(0.028)
    assert result["price"]["beta"] == pytest.approx(1.24)
    assert result["growth"]["forward_eps"] == pytest.approx(6.92)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python3 -m pytest container/skills/stock-screener/test_due_diligence.py::test_fetch_supplementary_returns_expected_fields -v
```

Expected: `AttributeError: module 'due_diligence' has no attribute '_fetch_supplementary'`

- [ ] **Step 3: Add supplementary fetch to `due_diligence.py`**

Append after `_safe_qs()` in `due_diligence.py`:

```python
def _fetch_dd_quotesummary(ticker: str) -> dict:
    """Fetch DD-specific modules from Yahoo Finance quoteSummary API.

    Uses the same session/crumb/retry pattern as stock_screener.py.
    """
    global _qs_session, _qs_crumb
    last_exc: Exception = RuntimeError("no attempts made")
    for attempt in range(_MAX_429_RETRIES + 1):
        try:
            session, crumb = _ensure_qs_session()
            resp = session.get(
                _QS_URL.format(ticker=ticker),
                params={"modules": _DD_MODULES, "crumb": crumb},
                timeout=_QS_TIMEOUT_DATA,
            )
            resp.raise_for_status()
        except _HTTP_ERRORS as exc:
            status = exc.response.status_code if exc.response is not None else None
            if status == 429 and attempt < _MAX_429_RETRIES:
                time.sleep(_429_BACKOFF_SECS[attempt])
                last_exc = exc
                continue
            if status in (401, 403) and attempt == 0:
                _qs_session = None
                _qs_crumb   = None
                last_exc = exc
                continue
            raise
        payload = resp.json()
        qs = payload.get("quoteSummary") or {}
        if qs.get("error"):
            raise ValueError(str(qs["error"]))
        results = qs.get("result") or []
        return results[0] if results else {}
    raise last_exc


def _fetch_supplementary(ticker: str) -> dict:
    """Fetch supplementary DD data from Yahoo Finance.

    Returns a dict with keys: description, analysts, ownership,
    insider_transactions, beta. All values are None / [] on error.
    """
    empty: dict = {
        "description": None, "analysts": None,
        "ownership": None, "insider_transactions": [], "beta": None,
    }
    try:
        modules = _fetch_dd_quotesummary(ticker)
    except Exception:
        return empty

    profile = modules.get("assetProfile") or {}
    fin_data = modules.get("financialData") or {}
    holders  = modules.get("majorHoldersBreakdown") or {}
    key_stat = modules.get("defaultKeyStatistics") or {}
    insider  = modules.get("insiderTransactions") or {}

    analysts = None
    if fin_data:
        analysts = {
            "target_mean":    _safe_qs(fin_data, "targetMeanPrice"),
            "target_high":    _safe_qs(fin_data, "targetHighPrice"),
            "target_low":     _safe_qs(fin_data, "targetLowPrice"),
            "num_analysts":   int(_safe_qs(fin_data, "numberOfAnalystOpinions") or 0) or None,
            "recommendation": fin_data.get("recommendationKey"),
            "forward_eps":    _safe_qs(fin_data, "forwardEps"),
        }

    ownership = None
    if holders or key_stat:
        ownership = {
            "insider_pct":       _safe_qs(holders,  "insidersPercentHeld"),
            "institutional_pct": _safe_qs(holders,  "institutionsPercentHeld"),
            "short_ratio":       _safe_qs(key_stat, "shortRatio"),
            "short_pct_of_float":_safe_qs(key_stat, "shortPercentOfFloat"),
        }

    transactions = []
    for txn in (insider.get("transactions") or []):
        date_obj = txn.get("transactionDate") or {}
        text = (txn.get("transactionText") or "").lower()
        txn_type = "buy" if "purchase" in text or "acquisition" in text else "sell"
        transactions.append({
            "date":   date_obj.get("fmt") if isinstance(date_obj, dict) else None,
            "name":   txn.get("filerName"),
            "type":   txn_type,
            "shares": int(_safe_qs(txn, "shares") or 0) or None,
            "value":  _safe_qs(txn, "value"),
        })

    return {
        "description":         profile.get("longBusinessSummary"),
        "analysts":            analysts,
        "ownership":           ownership,
        "insider_transactions": transactions,
        "beta":                _safe_qs(key_stat, "beta"),
    }


def _merge_supplementary(base: dict, supplementary: dict) -> dict:
    """Merge supplementary Yahoo Finance data into the base DB dict."""
    base["identification"]["description"] = supplementary.get("description")
    base["analysts"]            = supplementary.get("analysts")
    base["ownership"]           = supplementary.get("ownership")
    base["insider_transactions"] = supplementary.get("insider_transactions", [])
    if supplementary.get("beta") is not None:
        base["price"]["beta"] = supplementary["beta"]
    if supplementary.get("analysts") and supplementary["analysts"].get("forward_eps"):
        base["growth"]["forward_eps"] = supplementary["analysts"]["forward_eps"]
    return base
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python3 -m pytest container/skills/stock-screener/test_due_diligence.py -v
```

Expected: 9 PASSED

- [ ] **Step 5: Commit**

```bash
git add container/skills/stock-screener/due_diligence.py container/skills/stock-screener/test_due_diligence.py
git commit -m "feat(stock-suite): add due_diligence supplementary Yahoo fetch + merge"
```

---

## Task 4: Due Diligence — CLI `main()`

**Files:**
- Modify: `container/skills/stock-screener/due_diligence.py` (add main)
- Modify: `container/skills/stock-screener/test_due_diligence.py` (add CLI tests)

- [ ] **Step 1: Write the failing tests**

Append to `container/skills/stock-screener/test_due_diligence.py`:

```python
# ── Tests for main() ─────────────────────────────────────────────────────────

def test_main_outputs_json_array(tmp_path, capsys):
    db = tmp_path / "investments.db"
    conn = make_test_db(tmp_path)
    conn.close()
    supp = {
        "description": "Apple.", "analysts": None,
        "ownership": None, "insider_transactions": [], "beta": None,
    }
    with patch("due_diligence._fetch_supplementary", return_value=supp):
        ret = dd.main(["--tickers", "AAPL", "--db", str(db)])
    assert ret == 0
    out = capsys.readouterr().out
    data = json.loads(out)
    assert isinstance(data, list)
    assert len(data) == 1
    assert data[0]["ticker"] == "AAPL"


def test_main_unknown_ticker_emits_error(tmp_path, capsys):
    db = tmp_path / "investments.db"
    conn = make_test_db(tmp_path)
    conn.close()
    with patch("due_diligence._fetch_supplementary", return_value={"description":None,"analysts":None,"ownership":None,"insider_transactions":[],"beta":None}):
        ret = dd.main(["--tickers", "ZZZZ", "--db", str(db)])
    assert ret == 1
    err = capsys.readouterr().err
    assert "ZZZZ" in err


def test_main_calls_migrate(tmp_path, capsys):
    old_db = tmp_path / "stock_screener.db"
    conn = sqlite3.connect(old_db)
    # create minimum schema in old db
    conn.executescript("""
        CREATE TABLE companies (ticker TEXT PRIMARY KEY, name TEXT, sector TEXT,
            industry TEXT, currency TEXT, country TEXT,
            shares_outstanding INTEGER, beta REAL, last_updated TEXT NOT NULL);
        CREATE TABLE prices (ticker TEXT PRIMARY KEY, price REAL, market_cap REAL,
            trailing_pe REAL, forward_pe REAL, price_to_book REAL,
            enterprise_value REAL, trailing_eps REAL, dividend_yield REAL,
            peg_ratio REAL, ev_ebitda REAL, fifty_two_week_high REAL,
            fifty_two_week_low REAL, price_to_fcf REAL, fetched_at TEXT NOT NULL);
        CREATE TABLE annual_financials (ticker TEXT NOT NULL, period_end TEXT NOT NULL,
            revenue REAL, gross_profit REAL, operating_income REAL, net_income REAL,
            free_cashflow REAL, operating_cashflow REAL, total_debt REAL, cash_equiv REAL,
            total_equity REAL, total_assets REAL, current_assets REAL, current_liabilities REAL,
            gross_margin REAL, operating_margin REAL, net_margin REAL,
            roe REAL, roa REAL, roic REAL, current_ratio REAL, net_debt REAL, ebitda REAL,
            piotroski_f INTEGER, altman_z REAL, accruals_ratio REAL, cash_conversion REAL,
            revenue_cagr_3y REAL, revenue_cagr_5y REAL,
            PRIMARY KEY (ticker, period_end));
    """)
    conn.close()
    new_db = tmp_path / "investments.db"
    with patch("due_diligence._fetch_supplementary", return_value={"description":None,"analysts":None,"ownership":None,"insider_transactions":[],"beta":None}):
        dd.main(["--tickers", "AAPL", "--db", str(new_db)])
    assert new_db.exists()
    assert not old_db.exists()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python3 -m pytest container/skills/stock-screener/test_due_diligence.py::test_main_outputs_json_array -v
```

Expected: `AttributeError: module 'due_diligence' has no attribute 'main'`

- [ ] **Step 3: Add `main()` to `due_diligence.py`**

Append to `due_diligence.py`:

```python
# ── CLI ───────────────────────────────────────────────────────────────────────

def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Fetch DD data for tickers and output JSON.")
    parser.add_argument("--tickers", nargs="+", required=True, help="Ticker symbols")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="SQLite DB path")
    args = parser.parse_args(argv)

    # Rename stock_screener.db → investments.db if needed
    from migrate_db import migrate_db_file, ensure_new_tables
    migrate_db_file(args.db.parent)

    tickers = [t.strip().upper() for t in args.tickers if t.strip()]

    conn = sqlite3.connect(args.db)
    ensure_new_tables(conn)

    results = []
    errors  = []
    for ticker in tickers:
        base = _read_db_fundamentals(conn, ticker)
        if base is None:
            print(f"ERROR: {ticker} not found in DB — run stock_screener.py first", file=sys.stderr)
            errors.append(ticker)
            continue
        supplementary = _fetch_supplementary(ticker)
        results.append(_merge_supplementary(base, supplementary))

    conn.close()

    if results:
        print(json.dumps(results, indent=2, default=str))

    return 1 if errors and not results else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python3 -m pytest container/skills/stock-screener/test_due_diligence.py -v
```

Expected: 12 PASSED

- [ ] **Step 5: Commit**

```bash
git add container/skills/stock-screener/due_diligence.py container/skills/stock-screener/test_due_diligence.py
git commit -m "feat(stock-suite): add due_diligence CLI main()"
```

---

## Task 5: Technical Analysis — Indicator Computation

**Files:**
- Create: `container/skills/stock-screener/technical_analysis.py` (partial — indicators only)
- Create: `container/skills/stock-screener/test_technical_analysis.py` (partial)

- [ ] **Step 1: Write the failing tests**

Create `container/skills/stock-screener/test_technical_analysis.py`:

```python
"""Tests for technical_analysis.py"""
import json
import sys
import os
from datetime import date, timedelta
from unittest.mock import MagicMock, patch
import pandas as pd
import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import technical_analysis as ta


# ── OHLCV fixture ─────────────────────────────────────────────────────────────

def make_ohlcv(n: int = 300, base_price: float = 100.0) -> pd.DataFrame:
    """Generate synthetic OHLCV data with a gentle uptrend."""
    idx = pd.date_range(end=date.today(), periods=n, freq="B")
    np.random.seed(42)
    close = base_price + np.cumsum(np.random.randn(n) * 0.5 + 0.05)
    high  = close + np.abs(np.random.randn(n)) * 0.5
    low   = close - np.abs(np.random.randn(n)) * 0.5
    open_ = close + np.random.randn(n) * 0.3
    vol   = np.random.randint(1_000_000, 5_000_000, n).astype(float)
    return pd.DataFrame({"Open": open_, "High": high, "Low": low,
                         "Close": close, "Volume": vol}, index=idx)


# ── Tests for _compute_indicators ────────────────────────────────────────────

def test_compute_indicators_returns_expected_keys():
    df = make_ohlcv()
    result = ta._compute_indicators(df)
    for key in ["sma_50", "sma_200", "ema_20", "ema_50", "rsi_14",
                "macd", "signal", "histogram", "bb_upper", "bb_mid", "bb_lower",
                "atr_14", "volume_vs_avg", "pct_from_52w_high", "pct_from_52w_low"]:
        assert key in result, f"Missing key: {key}"


def test_sma_50_is_rolling_mean():
    df = make_ohlcv(300)
    result = ta._compute_indicators(df)
    expected = float(df["Close"].rolling(50).mean().iloc[-1])
    assert result["sma_50"] == pytest.approx(expected, rel=1e-6)


def test_sma_200_is_rolling_mean():
    df = make_ohlcv(300)
    result = ta._compute_indicators(df)
    expected = float(df["Close"].rolling(200).mean().iloc[-1])
    assert result["sma_200"] == pytest.approx(expected, rel=1e-6)


def test_rsi_bounded():
    df = make_ohlcv()
    result = ta._compute_indicators(df)
    assert 0 <= result["rsi_14"] <= 100


def test_bollinger_bands_ordering():
    df = make_ohlcv()
    result = ta._compute_indicators(df)
    assert result["bb_lower"] < result["bb_mid"] < result["bb_upper"]


def test_atr_positive():
    df = make_ohlcv()
    result = ta._compute_indicators(df)
    assert result["atr_14"] > 0


def test_52w_high_low_positioning():
    df = make_ohlcv(300)
    result = ta._compute_indicators(df)
    # pct_from_52w_high should be <= 0 (current price ≤ 52w high)
    assert result["pct_from_52w_high"] <= 0.01  # allow tiny float noise
    # pct_from_52w_low should be >= 0
    assert result["pct_from_52w_low"] >= -0.01


def test_golden_cross_detected():
    # Construct data where 50-day SMA > 200-day SMA (golden cross)
    df = make_ohlcv(300, base_price=100.0)
    # Force an uptrend so 50-day MA > 200-day MA
    df["Close"] = df["Close"] + np.linspace(0, 50, len(df))
    result = ta._compute_indicators(df)
    assert result["golden_cross"] is True
    assert result["death_cross"] is False


def test_macd_has_crossover_key():
    df = make_ohlcv()
    result = ta._compute_indicators(df)
    assert result["macd_crossover"] in ("bullish", "bearish", "neutral")
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python3 -m pytest container/skills/stock-screener/test_technical_analysis.py -v
```

Expected: `ModuleNotFoundError: No module named 'technical_analysis'`

- [ ] **Step 3: Write the indicator computation**

Create `container/skills/stock-screener/technical_analysis.py`:

```python
#!/usr/bin/env python3
"""technical_analysis.py — compute technical indicators and produce entry-point JSON.

Usage:
    python3 technical_analysis.py --tickers AAPL MSFT [--db PATH] [--horizon 2w]

Horizon values: 1w, 2w, 1m, 3m (default: 2w)
Outputs a JSON array to stdout. One object per ticker.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd
import yfinance as yf

DEFAULT_DB = Path("/workspace/group/investments.db")
VALID_HORIZONS = ("1w", "2w", "1m", "3m")


def _compute_rsi(close: pd.Series, period: int = 14) -> float:
    """Compute RSI for the last value of *close*."""
    delta = close.diff()
    gain  = delta.clip(lower=0)
    loss  = (-delta).clip(lower=0)
    avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, float("nan"))
    rsi = 100 - (100 / (1 + rs))
    return float(rsi.iloc[-1])


def _compute_indicators(df: pd.DataFrame) -> Dict[str, Any]:
    """Compute all technical indicators from an OHLCV DataFrame.

    *df* must have columns Open, High, Low, Close, Volume and a DatetimeIndex,
    sorted ascending (oldest first). Returns a flat dict of indicator values
    for the most recent bar.
    """
    close  = df["Close"]
    high   = df["High"]
    low    = df["Low"]
    volume = df["Volume"]

    # Moving averages
    sma_50  = float(close.rolling(50).mean().iloc[-1])
    sma_200 = float(close.rolling(200).mean().iloc[-1])
    ema_20  = float(close.ewm(span=20, adjust=False).mean().iloc[-1])
    ema_50  = float(close.ewm(span=50, adjust=False).mean().iloc[-1])

    # RSI(14)
    rsi_14 = _compute_rsi(close, 14)

    # MACD(12, 26, 9)
    ema_12  = close.ewm(span=12, adjust=False).mean()
    ema_26  = close.ewm(span=26, adjust=False).mean()
    macd    = ema_12 - ema_26
    signal  = macd.ewm(span=9, adjust=False).mean()
    hist    = macd - signal
    macd_val    = float(macd.iloc[-1])
    signal_val  = float(signal.iloc[-1])
    hist_val    = float(hist.iloc[-1])
    # Crossover: current histogram positive and previous negative → bullish
    if len(hist) >= 2:
        if hist_val > 0 and float(hist.iloc[-2]) <= 0:
            crossover = "bullish"
        elif hist_val < 0 and float(hist.iloc[-2]) >= 0:
            crossover = "bearish"
        else:
            crossover = "neutral"
    else:
        crossover = "neutral"

    # Bollinger Bands (20, 2σ)
    bb_mid   = close.rolling(20).mean()
    bb_std   = close.rolling(20).std()
    bb_upper = float((bb_mid + 2 * bb_std).iloc[-1])
    bb_mid_v = float(bb_mid.iloc[-1])
    bb_lower = float((bb_mid - 2 * bb_std).iloc[-1])

    # ATR(14)
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low  - prev_close).abs(),
    ], axis=1).max(axis=1)
    atr_14 = float(tr.rolling(14).mean().iloc[-1])

    # Volume vs 20-day average
    vol_avg = float(volume.rolling(20).mean().iloc[-1])
    volume_vs_avg = float(volume.iloc[-1]) / vol_avg if vol_avg > 0 else 1.0

    # 52-week high/low positioning
    year_slice = close.last("252B") if len(close) >= 252 else close
    w52_high = float(year_slice.max())
    w52_low  = float(year_slice.min())
    current  = float(close.iloc[-1])
    pct_from_52w_high = (current - w52_high) / w52_high if w52_high != 0 else 0.0
    pct_from_52w_low  = (current - w52_low)  / w52_low  if w52_low  != 0 else 0.0

    # Golden / death cross
    golden_cross = sma_50 > sma_200
    death_cross  = sma_50 < sma_200

    return {
        "current_price":     current,
        "sma_50":            sma_50,
        "sma_200":           sma_200,
        "ema_20":            ema_20,
        "ema_50":            ema_50,
        "rsi_14":            rsi_14,
        "macd":              macd_val,
        "signal":            signal_val,
        "histogram":         hist_val,
        "macd_crossover":    crossover,
        "bb_upper":          bb_upper,
        "bb_mid":            bb_mid_v,
        "bb_lower":          bb_lower,
        "atr_14":            atr_14,
        "volume_vs_avg":     round(volume_vs_avg, 3),
        "pct_from_52w_high": round(pct_from_52w_high, 4),
        "pct_from_52w_low":  round(pct_from_52w_low,  4),
        "52w_high":          w52_high,
        "52w_low":           w52_low,
        "golden_cross":      golden_cross,
        "death_cross":       death_cross,
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python3 -m pytest container/skills/stock-screener/test_technical_analysis.py -v
```

Expected: 9 PASSED

- [ ] **Step 5: Commit**

```bash
git add container/skills/stock-screener/technical_analysis.py container/skills/stock-screener/test_technical_analysis.py
git commit -m "feat(stock-suite): add technical_analysis indicator computation + tests"
```

---

## Task 6: Technical Analysis — Entry Zone, Support/Resistance, CLI

**Files:**
- Modify: `container/skills/stock-screener/technical_analysis.py` (add entry zone + CLI)
- Modify: `container/skills/stock-screener/test_technical_analysis.py` (add entry zone tests)

- [ ] **Step 1: Write the failing tests**

Append to `container/skills/stock-screener/test_technical_analysis.py`:

```python
# ── Tests for _determine_entry_zone ──────────────────────────────────────────

def _make_indicators(rsi: float = 50.0, crossover: str = "neutral",
                     pct_from_52w_high: float = -0.1,
                     bb_position: str = "mid") -> dict:
    """Helper to build a minimal indicators dict for entry zone tests."""
    current = 100.0
    bb_mid = 100.0
    if bb_position == "upper":
        bb_upper, bb_lower = 102.0, 98.0
        current = 101.5
    elif bb_position == "lower":
        bb_upper, bb_lower = 102.0, 98.0
        current = 98.5
    else:
        bb_upper, bb_lower = 102.0, 98.0
    return {
        "current_price": current, "rsi_14": rsi,
        "macd_crossover": crossover, "pct_from_52w_high": pct_from_52w_high,
        "bb_upper": bb_upper, "bb_mid": bb_mid, "bb_lower": bb_lower,
        "sma_50": 99.0, "sma_200": 95.0, "ema_20": 100.5, "ema_50": 99.5,
        "golden_cross": True, "death_cross": False,
        "macd": 0.5, "signal": 0.3, "histogram": 0.2,
        "atr_14": 1.5, "volume_vs_avg": 1.1,
        "52w_high": 115.0, "52w_low": 85.0,
        "pct_from_52w_low": 0.18,
    }


def test_entry_zone_overbought():
    ind = _make_indicators(rsi=74.0, bb_position="upper")
    result = ta._determine_entry_zone(ind, "2w")
    assert result["entry_zone"] == "overbought_avoid"


def test_entry_zone_oversold():
    ind = _make_indicators(rsi=28.0, bb_position="lower")
    result = ta._determine_entry_zone(ind, "2w")
    assert result["entry_zone"] == "oversold_watch"


def test_entry_zone_entry_now_bullish():
    ind = _make_indicators(rsi=52.0, crossover="bullish", pct_from_52w_high=-0.15)
    result = ta._determine_entry_zone(ind, "2w")
    assert result["entry_zone"] == "entry_now"


def test_entry_zone_wait_for_pullback():
    # RSI elevated but not overbought, not a fresh crossover
    ind = _make_indicators(rsi=63.0, crossover="neutral", pct_from_52w_high=-0.03)
    result = ta._determine_entry_zone(ind, "2w")
    assert result["entry_zone"] == "wait_for_pullback"


def test_entry_zone_includes_key_levels():
    df = make_ohlcv()
    ind = ta._compute_indicators(df)
    result = ta._determine_entry_zone(ind, "2w")
    assert "support" in result["key_levels"]
    assert "resistance" in result["key_levels"]
    assert result["key_levels"]["support"] < result["key_levels"]["resistance"]


def test_entry_zone_includes_summary_string():
    df = make_ohlcv()
    ind = ta._compute_indicators(df)
    result = ta._determine_entry_zone(ind, "1m")
    assert isinstance(result["summary"], str)
    assert len(result["summary"]) > 20


# ── Tests for main() ─────────────────────────────────────────────────────────

def test_ta_main_outputs_json_array(capsys):
    df = make_ohlcv(300)
    with patch("technical_analysis.yf.download", return_value=df):
        ret = ta.main(["--tickers", "AAPL", "--horizon", "2w",
                       "--db", "/tmp/dummy.db"])
    assert ret == 0
    out = capsys.readouterr().out
    data = json.loads(out)
    assert isinstance(data, list)
    assert data[0]["ticker"] == "AAPL"
    assert data[0]["horizon"] == "2w"
    assert "entry_zone" in data[0]
    assert "indicators" in data[0]


def test_ta_main_invalid_horizon(capsys):
    ret = ta.main(["--tickers", "AAPL", "--horizon", "99y", "--db", "/tmp/dummy.db"])
    assert ret == 1


def test_ta_main_fetch_failure(capsys):
    with patch("technical_analysis.yf.download", return_value=pd.DataFrame()):
        ret = ta.main(["--tickers", "FAIL", "--horizon", "2w", "--db", "/tmp/dummy.db"])
    assert ret == 1
    err = capsys.readouterr().err
    assert "FAIL" in err
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python3 -m pytest container/skills/stock-screener/test_technical_analysis.py::test_entry_zone_overbought -v
```

Expected: `AttributeError: module 'technical_analysis' has no attribute '_determine_entry_zone'`

- [ ] **Step 3: Add entry zone logic and `main()` to `technical_analysis.py`**

Append to `technical_analysis.py`:

```python
def _find_support_resistance(df: pd.DataFrame) -> Dict[str, float]:
    """Find recent support and resistance using recent swing lows/highs.

    Uses the 20-day SMA as a proxy for support and the 52-week high area for
    resistance when swing analysis is inconclusive.
    """
    close = df["Close"]
    current = float(close.iloc[-1])

    # Support: 50-day SMA or recent swing low (whichever is lower and below current)
    sma_50 = float(close.rolling(50).mean().iloc[-1])
    recent_low = float(close.tail(60).min())
    support = min(sma_50, recent_low) if min(sma_50, recent_low) < current else sma_50

    # Resistance: recent swing high above current price
    recent_high = float(close.tail(60).max())
    resistance = recent_high if recent_high > current else float(close.tail(20).max())

    return {"support": round(support, 2), "resistance": round(resistance, 2)}


def _determine_entry_zone(indicators: Dict[str, Any], horizon: str) -> Dict[str, Any]:
    """Classify the entry zone and generate a concise summary.

    Rules (applied in priority order):
    1. RSI > 70 OR price in upper Bollinger quarter → overbought_avoid
    2. RSI < 30 OR price in lower Bollinger quarter → oversold_watch
    3. For short horizons (1w/2w): bullish MACD crossover + RSI < 65 → entry_now
    4. For medium horizons (1m/3m): golden cross + RSI < 60 + price > SMA50 → entry_now
    5. Otherwise → wait_for_pullback
    """
    rsi          = indicators["rsi_14"]
    current      = indicators["current_price"]
    bb_upper     = indicators["bb_upper"]
    bb_lower     = indicators["bb_lower"]
    bb_range     = bb_upper - bb_lower
    bb_position  = (current - bb_lower) / bb_range if bb_range > 0 else 0.5
    crossover    = indicators["macd_crossover"]
    golden_cross = indicators["golden_cross"]
    sma_50       = indicators["sma_50"]

    if rsi > 70 or bb_position > 0.85:
        zone = "overbought_avoid"
    elif rsi < 30 or bb_position < 0.15:
        zone = "oversold_watch"
    elif horizon in ("1w", "2w"):
        if crossover == "bullish" and rsi < 65:
            zone = "entry_now"
        else:
            zone = "wait_for_pullback"
    else:  # 1m, 3m
        if golden_cross and rsi < 60 and current > sma_50:
            zone = "entry_now"
        else:
            zone = "wait_for_pullback"

    # Key levels: approximate from indicators
    support    = round(min(indicators["sma_50"], indicators["ema_50"]), 2)
    resistance = round(indicators["52w_high"] * 0.98, 2) if "52w_high" in indicators else round(bb_upper, 2)
    key_levels = {"support": support, "resistance": resistance}

    # One-line summary
    zone_desc = {
        "entry_now":       "Conditions look favorable for entry",
        "wait_for_pullback": f"Wait for a pullback toward the {horizon} support zone (~{support:.2f})",
        "overbought_avoid": "RSI elevated — wait for a cooldown before entering",
        "oversold_watch":   "Oversold — watch for stabilization before entering",
    }
    rsi_str = f"RSI {rsi:.0f}"
    ma_str  = "above 50-day MA" if current > sma_50 else "below 50-day MA"
    summary = f"{zone_desc[zone]}. {rsi_str}, {ma_str}. Support ~{support:.2f}, resistance ~{resistance:.2f}."

    return {
        "entry_zone": zone,
        "key_levels": key_levels,
        "summary":    summary,
    }


def fetch_ohlcv(ticker: str) -> Optional[pd.DataFrame]:
    """Fetch 2 years of daily OHLCV for *ticker* via yfinance. Returns None on failure."""
    df = yf.download(ticker, period="2y", interval="1d", progress=False, auto_adjust=True)
    if df is None or df.empty or len(df) < 50:
        return None
    # yfinance may return MultiIndex columns for a single ticker — flatten
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    return df.sort_index()


# ── CLI ───────────────────────────────────────────────────────────────────────

def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Compute technical indicators and output entry-point JSON.")
    parser.add_argument("--tickers",  nargs="+", required=True, help="Ticker symbols")
    parser.add_argument("--horizon",  default="2w", choices=list(VALID_HORIZONS) + ["1w","2w","1m","3m"],
                        help="Investment horizon: 1w, 2w, 1m, 3m (default: 2w)")
    parser.add_argument("--db",       type=Path, default=DEFAULT_DB, help="SQLite DB path (unused by this script)")
    args = parser.parse_args(argv)

    if args.horizon not in VALID_HORIZONS:
        print(f"ERROR: invalid horizon '{args.horizon}'. Choose from: {', '.join(VALID_HORIZONS)}", file=sys.stderr)
        return 1

    tickers = [t.strip().upper() for t in args.tickers if t.strip()]

    results = []
    errors  = []
    for ticker in tickers:
        df = fetch_ohlcv(ticker)
        if df is None:
            print(f"ERROR: could not fetch price data for {ticker}", file=sys.stderr)
            errors.append(ticker)
            continue
        indicators = _compute_indicators(df)
        entry      = _determine_entry_zone(indicators, args.horizon)
        results.append({
            "ticker":     ticker,
            "horizon":    args.horizon,
            "entry_zone": entry["entry_zone"],
            "key_levels": entry["key_levels"],
            "summary":    entry["summary"],
            "indicators": indicators,
        })

    if results:
        print(json.dumps(results, indent=2, default=str))

    return 1 if errors and not results else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run all technical analysis tests**

```bash
python3 -m pytest container/skills/stock-screener/test_technical_analysis.py -v
```

Expected: 18 PASSED

- [ ] **Step 5: Commit**

```bash
git add container/skills/stock-screener/technical_analysis.py container/skills/stock-screener/test_technical_analysis.py
git commit -m "feat(stock-suite): add technical_analysis entry zone + CLI"
```

---

## Task 7: Portfolio Manager — Holdings CRUD

**Files:**
- Create: `container/skills/stock-screener/portfolio_manager.py` (partial)
- Create: `container/skills/stock-screener/test_portfolio_manager.py` (partial)

- [ ] **Step 1: Write the failing tests**

Create `container/skills/stock-screener/test_portfolio_manager.py`:

```python
"""Tests for portfolio_manager.py"""
import json
import sqlite3
import sys
import os
from datetime import date
from pathlib import Path
from unittest.mock import patch
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import migrate_db as mdb
import portfolio_manager as pm


# ── DB fixture ────────────────────────────────────────────────────────────────

def make_test_db(tmp_path: Path) -> sqlite3.Connection:
    db = tmp_path / "investments.db"
    conn = sqlite3.connect(db)
    conn.executescript("""
        CREATE TABLE companies (
            ticker TEXT PRIMARY KEY, name TEXT, sector TEXT, industry TEXT,
            currency TEXT, country TEXT, shares_outstanding INTEGER, beta REAL,
            last_updated TEXT NOT NULL
        );
        CREATE TABLE prices (
            ticker TEXT PRIMARY KEY, price REAL, market_cap REAL,
            trailing_pe REAL, forward_pe REAL, price_to_book REAL,
            enterprise_value REAL, trailing_eps REAL, dividend_yield REAL,
            peg_ratio REAL, ev_ebitda REAL, fifty_two_week_high REAL,
            fifty_two_week_low REAL, price_to_fcf REAL, fetched_at TEXT NOT NULL
        );
        CREATE TABLE annual_financials (
            ticker TEXT NOT NULL, period_end TEXT NOT NULL,
            revenue REAL, net_income REAL, free_cashflow REAL,
            roic REAL, gross_margin REAL, operating_margin REAL, net_margin REAL,
            total_debt REAL, cash_equiv REAL,
            PRIMARY KEY (ticker, period_end)
        );
    """)
    mdb.ensure_new_tables(conn)
    now = "2026-04-05T00:00:00+00:00"
    conn.execute("INSERT INTO companies VALUES ('AAPL','Apple Inc.','Technology','Consumer Electronics','USD','US',15000000000,1.24,?)", (now,))
    conn.execute("INSERT INTO companies VALUES ('MSFT','Microsoft Corp.','Technology','Software','USD','US',7400000000,0.9,?)", (now,))
    conn.execute("INSERT INTO prices VALUES ('AAPL',192.3,2.85e12,31.2,27.8,8.4,2.9e12,6.13,0.0052,2.1,22.1,199.6,164.1,28.4,?)", (now,))
    conn.execute("INSERT INTO prices VALUES ('MSFT',415.0,3.1e12,35.0,30.0,12.0,3.2e12,11.0,0.008,2.3,25.0,440.0,360.0,32.0,?)", (now,))
    conn.execute("INSERT INTO annual_financials VALUES ('AAPL','2025-09-30',391e9,93.7e9,99.5e9,0.54,0.458,0.312,0.254,104e9,67e9)", )
    conn.execute("INSERT INTO annual_financials VALUES ('MSFT','2025-06-30',245e9,88e9,74e9,0.35,0.69,0.43,0.36,80e9,18e9)", )
    conn.commit()
    return conn


# ── Tests for upsert_holding ─────────────────────────────────────────────────

def test_upsert_holding_insert(tmp_path):
    conn = make_test_db(tmp_path)
    pm.upsert_holding(conn, "AAPL", shares=50.0, avg_buy_price=175.0,
                      buy_date="2025-01-15", currency="USD")
    row = conn.execute(
        "SELECT ticker, shares, avg_buy_price FROM portfolio_holdings WHERE ticker='AAPL'"
    ).fetchone()
    assert row == ("AAPL", 50.0, 175.0)
    conn.close()


def test_upsert_holding_update_shares(tmp_path):
    conn = make_test_db(tmp_path)
    pm.upsert_holding(conn, "AAPL", shares=50.0, avg_buy_price=175.0,
                      buy_date="2025-01-15", currency="USD")
    pm.upsert_holding(conn, "AAPL", shares=80.0, avg_buy_price=182.0,
                      buy_date="2025-01-15", currency="USD")
    row = conn.execute(
        "SELECT shares, avg_buy_price FROM portfolio_holdings WHERE ticker='AAPL'"
    ).fetchone()
    assert row == (80.0, 182.0)
    conn.close()


def test_delete_holding(tmp_path):
    conn = make_test_db(tmp_path)
    pm.upsert_holding(conn, "AAPL", shares=50.0, avg_buy_price=175.0,
                      buy_date="2025-01-15", currency="USD")
    pm.delete_holding(conn, "AAPL")
    row = conn.execute(
        "SELECT * FROM portfolio_holdings WHERE ticker='AAPL'"
    ).fetchone()
    assert row is None
    conn.close()


def test_delete_holding_nonexistent_is_noop(tmp_path):
    conn = make_test_db(tmp_path)
    pm.delete_holding(conn, "ZZZZ")  # must not raise
    conn.close()


def test_list_holdings_empty(tmp_path):
    conn = make_test_db(tmp_path)
    assert pm.list_holdings(conn) == []
    conn.close()


def test_list_holdings_returns_all(tmp_path):
    conn = make_test_db(tmp_path)
    pm.upsert_holding(conn, "AAPL", 50.0, 175.0, "2025-01-15", "USD")
    pm.upsert_holding(conn, "MSFT", 20.0, 380.0, "2025-02-01", "USD")
    holdings = pm.list_holdings(conn)
    tickers = {h["ticker"] for h in holdings}
    assert tickers == {"AAPL", "MSFT"}
    conn.close()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python3 -m pytest container/skills/stock-screener/test_portfolio_manager.py::test_upsert_holding_insert -v
```

Expected: `ModuleNotFoundError: No module named 'portfolio_manager'`

- [ ] **Step 3: Write the holdings CRUD**

Create `container/skills/stock-screener/portfolio_manager.py`:

```python
#!/usr/bin/env python3
"""portfolio_manager.py — portfolio holdings CRUD and performance computation.

Usage:
    python3 portfolio_manager.py --db PATH

Outputs a JSON object to stdout with portfolio summary and per-holding details.
The agent enriches this with web search (news + macro) and saves to the reports table.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone, date
from pathlib import Path
from typing import Any, Dict, List, Optional

DEFAULT_DB = Path("/workspace/group/investments.db")


def upsert_holding(
    conn: sqlite3.Connection,
    ticker: str,
    shares: float,
    avg_buy_price: float,
    buy_date: str,
    currency: str = "USD",
    notes: Optional[str] = None,
) -> None:
    """Insert or replace a holding in portfolio_holdings."""
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """INSERT OR REPLACE INTO portfolio_holdings
               (ticker, shares, avg_buy_price, buy_date, currency, notes, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (ticker.upper(), shares, avg_buy_price, buy_date, currency, notes, now),
    )
    conn.commit()


def delete_holding(conn: sqlite3.Connection, ticker: str) -> None:
    """Remove a holding from portfolio_holdings. No-op if not found."""
    conn.execute("DELETE FROM portfolio_holdings WHERE ticker=?", (ticker.upper(),))
    conn.commit()


def list_holdings(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    """Return all rows from portfolio_holdings as a list of dicts."""
    rows = conn.execute(
        """SELECT ticker, shares, avg_buy_price, buy_date, currency, notes
           FROM portfolio_holdings ORDER BY ticker"""
    ).fetchall()
    return [
        {"ticker": r[0], "shares": r[1], "avg_buy_price": r[2],
         "buy_date": r[3], "currency": r[4], "notes": r[5]}
        for r in rows
    ]
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python3 -m pytest container/skills/stock-screener/test_portfolio_manager.py -v
```

Expected: 7 PASSED

- [ ] **Step 5: Commit**

```bash
git add container/skills/stock-screener/portfolio_manager.py container/skills/stock-screener/test_portfolio_manager.py
git commit -m "feat(stock-suite): add portfolio_manager holdings CRUD + tests"
```

---

## Task 8: Portfolio Manager — Portfolio Computation + CLI

**Files:**
- Modify: `container/skills/stock-screener/portfolio_manager.py` (add computation + CLI)
- Modify: `container/skills/stock-screener/test_portfolio_manager.py` (add computation tests)

- [ ] **Step 1: Write the failing tests**

Append to `container/skills/stock-screener/test_portfolio_manager.py`:

```python
# ── Tests for compute_portfolio ───────────────────────────────────────────────

def test_compute_portfolio_returns_expected_keys(tmp_path):
    conn = make_test_db(tmp_path)
    pm.upsert_holding(conn, "AAPL", 50.0, 175.0, "2025-01-15", "USD")
    result = pm.compute_portfolio(conn)
    assert "portfolio_summary" in result
    assert "holdings" in result
    assert "sector_allocation" in result
    assert "concentration_warnings" in result
    conn.close()


def test_compute_portfolio_calculates_return(tmp_path):
    conn = make_test_db(tmp_path)
    pm.upsert_holding(conn, "AAPL", 50.0, 175.0, "2025-01-15", "USD")
    result = pm.compute_portfolio(conn)
    holding = result["holdings"][0]
    # AAPL current price is 192.3 in test DB
    assert holding["current_price"] == pytest.approx(192.3)
    assert holding["return_pct"] == pytest.approx((192.3 / 175.0 - 1) * 100, rel=1e-3)
    assert holding["return_abs"] == pytest.approx((192.3 - 175.0) * 50.0, rel=1e-3)
    conn.close()


def test_compute_portfolio_total_invested(tmp_path):
    conn = make_test_db(tmp_path)
    pm.upsert_holding(conn, "AAPL", 50.0, 175.0, "2025-01-15", "USD")
    pm.upsert_holding(conn, "MSFT", 20.0, 380.0, "2025-02-01", "USD")
    result = pm.compute_portfolio(conn)
    expected_invested = 50.0 * 175.0 + 20.0 * 380.0
    assert result["portfolio_summary"]["total_invested"] == pytest.approx(expected_invested)
    conn.close()


def test_compute_portfolio_sector_allocation(tmp_path):
    conn = make_test_db(tmp_path)
    pm.upsert_holding(conn, "AAPL", 50.0, 175.0, "2025-01-15", "USD")
    pm.upsert_holding(conn, "MSFT", 20.0, 380.0, "2025-02-01", "USD")
    result = pm.compute_portfolio(conn)
    assert "Technology" in result["sector_allocation"]
    total = sum(result["sector_allocation"].values())
    assert total == pytest.approx(1.0, abs=0.01)
    conn.close()


def test_compute_portfolio_concentration_warning(tmp_path):
    conn = make_test_db(tmp_path)
    # AAPL at 50 shares × $175 = $8750; add tiny MSFT position
    pm.upsert_holding(conn, "AAPL", 500.0, 175.0, "2025-01-15", "USD")
    pm.upsert_holding(conn, "MSFT", 1.0, 380.0, "2025-02-01", "USD")
    result = pm.compute_portfolio(conn)
    assert "AAPL" in result["concentration_warnings"]
    conn.close()


def test_compute_portfolio_empty_holdings(tmp_path):
    conn = make_test_db(tmp_path)
    result = pm.compute_portfolio(conn)
    assert result["portfolio_summary"]["total_invested"] == 0.0
    assert result["holdings"] == []
    conn.close()


# ── Tests for main() ─────────────────────────────────────────────────────────

def test_pm_main_outputs_json(tmp_path, capsys):
    conn = make_test_db(tmp_path)
    pm.upsert_holding(conn, "AAPL", 50.0, 175.0, "2025-01-15", "USD")
    conn.close()
    db = tmp_path / "investments.db"
    ret = pm.main(["--db", str(db)])
    assert ret == 0
    out = capsys.readouterr().out
    data = json.loads(out)
    assert "portfolio_summary" in data
    assert len(data["holdings"]) == 1


def test_pm_main_empty_portfolio(tmp_path, capsys):
    conn = make_test_db(tmp_path)
    conn.close()
    db = tmp_path / "investments.db"
    ret = pm.main(["--db", str(db)])
    assert ret == 0
    out = capsys.readouterr().out
    data = json.loads(out)
    assert data["holdings"] == []
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python3 -m pytest container/skills/stock-screener/test_portfolio_manager.py::test_compute_portfolio_returns_expected_keys -v
```

Expected: `AttributeError: module 'portfolio_manager' has no attribute 'compute_portfolio'`

- [ ] **Step 3: Add `compute_portfolio()` and `main()` to `portfolio_manager.py`**

Append to `portfolio_manager.py`:

```python
def compute_portfolio(conn: sqlite3.Connection) -> Dict[str, Any]:
    """Compute portfolio performance by joining holdings with DB prices and fundamentals.

    Returns a dict with portfolio_summary, holdings list, sector_allocation,
    and concentration_warnings. Uses current prices from the prices table —
    run stock_screener.py first to refresh prices if needed.
    """
    holdings = list_holdings(conn)
    if not holdings:
        return {
            "portfolio_summary": {"total_invested": 0.0, "current_value": 0.0,
                                   "return_pct": 0.0, "return_abs": 0.0},
            "holdings": [],
            "sector_allocation": {},
            "concentration_warnings": [],
        }

    today_str = date.today().isoformat()

    enriched = []
    for h in holdings:
        ticker = h["ticker"]

        price_row = conn.execute(
            "SELECT price FROM prices WHERE ticker=?", (ticker,)
        ).fetchone()
        current_price = price_row[0] if price_row and price_row[0] else None

        company_row = conn.execute(
            "SELECT name, sector FROM companies WHERE ticker=?", (ticker,)
        ).fetchone()
        name   = company_row[0] if company_row else ticker
        sector = company_row[1] if company_row else "Unknown"

        latest_fin = conn.execute(
            """SELECT roic, gross_margin, operating_margin, net_margin, total_debt
               FROM annual_financials WHERE ticker=?
               ORDER BY period_end DESC LIMIT 1""",
            (ticker,)
        ).fetchone()

        # Prior DD report score
        prior_dd = conn.execute(
            """SELECT recommendation, generated_at, content FROM reports
               WHERE report_type='due_diligence' AND tickers LIKE ?
               ORDER BY generated_at DESC LIMIT 1""",
            (f"%{ticker}%",)
        ).fetchone()

        invested   = h["shares"] * h["avg_buy_price"]
        curr_value = (h["shares"] * current_price) if current_price else None
        ret_abs    = (curr_value - invested)       if curr_value else None
        ret_pct    = (ret_abs / invested * 100)    if (ret_abs is not None and invested > 0) else None

        # Days held
        try:
            days_held = (date.today() - date.fromisoformat(h["buy_date"])).days
        except (ValueError, TypeError):
            days_held = None

        enriched.append({
            "ticker":         ticker,
            "name":           name,
            "sector":         sector,
            "shares":         h["shares"],
            "avg_buy_price":  h["avg_buy_price"],
            "buy_date":       h["buy_date"],
            "current_price":  current_price,
            "return_pct":     round(ret_pct,  2) if ret_pct  is not None else None,
            "return_abs":     round(ret_abs,  2) if ret_abs  is not None else None,
            "current_value":  round(curr_value, 2) if curr_value is not None else None,
            "invested":       round(invested,  2),
            "days_held":      days_held,
            "latest_roic":    latest_fin[0] if latest_fin else None,
            "thesis_flags":   [],
            "thesis_concerns": [],
            "prior_dd_recommendation": prior_dd[0] if prior_dd else None,
            "prior_dd_date":           prior_dd[1] if prior_dd else None,
        })

    # Portfolio-level aggregates
    total_invested = sum(e["invested"]       for e in enriched)
    total_value    = sum(e["current_value"]  for e in enriched if e["current_value"] is not None)
    ret_abs_total  = total_value - total_invested if total_value else None
    ret_pct_total  = (ret_abs_total / total_invested * 100) if (ret_abs_total is not None and total_invested > 0) else None

    # Sector allocation by current value
    sector_values: Dict[str, float] = {}
    for e in enriched:
        cv = e["current_value"] or e["invested"]
        sector_values[e["sector"]] = sector_values.get(e["sector"], 0.0) + cv
    total_cv = sum(sector_values.values()) or 1.0
    sector_allocation = {s: round(v / total_cv, 4) for s, v in sector_values.items()}

    # Concentration warnings (> 20% of portfolio)
    concentration_warnings = [
        e["ticker"]
        for e in enriched
        if ((e["current_value"] or e["invested"]) / total_cv) > 0.20
    ]

    enriched.sort(key=lambda e: e["return_pct"] or 0, reverse=True)

    return {
        "portfolio_summary": {
            "total_invested": round(total_invested, 2),
            "current_value":  round(total_value,    2),
            "return_pct":     round(ret_pct_total,  2) if ret_pct_total is not None else None,
            "return_abs":     round(ret_abs_total,  2) if ret_abs_total is not None else None,
        },
        "holdings":               enriched,
        "sector_allocation":      sector_allocation,
        "concentration_warnings": concentration_warnings,
    }


# ── CLI ───────────────────────────────────────────────────────────────────────

def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Compute portfolio performance and output JSON.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="SQLite DB path")
    args = parser.parse_args(argv)

    from migrate_db import migrate_db_file, ensure_new_tables
    migrate_db_file(args.db.parent)

    conn = sqlite3.connect(args.db)
    ensure_new_tables(conn)

    result = compute_portfolio(conn)
    conn.close()

    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run all portfolio manager tests**

```bash
python3 -m pytest container/skills/stock-screener/test_portfolio_manager.py -v
```

Expected: 15 PASSED

- [ ] **Step 5: Commit**

```bash
git add container/skills/stock-screener/portfolio_manager.py container/skills/stock-screener/test_portfolio_manager.py
git commit -m "feat(stock-suite): add portfolio_manager compute + CLI"
```

---

## Task 9: Run Full Test Suite

- [ ] **Step 1: Run all stock-screener tests**

```bash
python3 -m pytest container/skills/stock-screener/ -v
```

Expected: All tests PASSED, no regressions in existing tests.

- [ ] **Step 2: Fix any regressions**

If existing tests fail, investigate — the most likely cause is a naming collision or import side-effect. Do not use `--ignore` to hide failures.

- [ ] **Step 3: Commit if fixes were needed**

```bash
git add -p
git commit -m "fix(stock-suite): resolve test regressions"
```

---

## Task 10: SKILL-dd.md — DD Analysis Framework

**Files:**
- Create: `container/skills/stock-screener/SKILL-dd.md`

- [ ] **Step 1: Create SKILL-dd.md**

Create `container/skills/stock-screener/SKILL-dd.md` with the following content (the DD analysis framework previously authored by the user, adapted for Telegram formatting):

```markdown
---
name: stock-dd
description: >
  Stock due diligence and fundamental analysis skill. Use when the user sends
  a ticker symbol and wants an investment analysis, DD report, or asks
  "should I buy X?", "analyze X", "DD on X", "what do you think of X stock?".
  Also triggers on "run DD", "research [ticker]", "investment memo", or any
  request to evaluate a stock as a long-term investment.
---

# Stock Due Diligence Skill

When triggered, produce a structured investment memo for the given ticker.
The memo targets a long-term value/growth investor — someone looking for
quality businesses at reasonable prices, not momentum trades.

## Input

A stock ticker symbol (e.g. AAPL, MSFT, GOOG). The user may also provide
context like "I already own this" or "thinking of adding to my portfolio" —
factor that into the bottom-line recommendation.

## How to Fetch the Data

Run due_diligence.py to get the structured JSON blob:

```bash
python3 /home/node/.claude/skills/stock-screener/due_diligence.py \
  --tickers <TICKER> \
  --db /workspace/group/investments.db
```

The script outputs a JSON array. Parse the first element for the ticker's data.

## Data You'll Receive

The JSON blob contains these sections (some fields may be null):

- **identification**: name, sector, industry, market_cap, enterprise_value, description
- **price**: current_price, 52w_high, 52w_low, beta
- **valuation**: pe_trailing, pe_forward, peg_ratio, price_to_book, ev_to_ebitda, price_to_fcf, trailing_eps, forward_eps
- **profitability**: gross_margin, operating_margin, net_margin, roe, roa, roic
- **health**: total_debt, total_cash, net_debt, current_ratio, free_cash_flow, operating_cash_flow
- **growth**: revenue_cagr_3y, revenue_cagr_5y, trailing_eps, forward_eps
- **dividends**: dividend_yield, payout_ratio
- **analysts**: target_mean, target_low, target_high, num_analysts, recommendation, forward_eps
- **ownership**: insider_pct, institutional_pct, short_ratio, short_pct_of_float
- **insider_transactions**: recent buys/sells (date, name, type, shares, value)
- **historical.annual**: up to 5 years of income statement, balance sheet, and cash flow fields
- **piotroski_f**: integer score 0–9
- **altman_z**: Altman Z' score

## Analysis Framework

Work through these five lenses in order. For each, state what the data shows
and whether it's a strength, neutral, or concern.

### 1. Business Quality & Moat

- Summarize what the company does in one sentence using the description field.
- Identify the likely moat type: network effects, switching costs, brand/pricing power, cost advantage, regulatory/scale barriers, or none evident.
- Use gross_margin as a moat proxy: >50% suggests pricing power, <20% suggests commodity economics.
- Check roic: sustained >15% across the historical data = durable advantage. <8% = no clear moat.
- Check if operating_margin is stable or compressing across years — margin erosion signals competitive pressure.

### 2. Financial Health

- **Debt**: compare total_debt to operating_cash_flow. If debt > 4× OCF, flag it.
- **Current ratio**: >1.5 is healthy, <1.0 is a liquidity concern.
- **Free cash flow**: must be positive. Compare free_cash_flow to net_income — if FCF is consistently lower, earnings quality is suspect. If FCF exceeds net_income, that's a positive signal.
- **Altman Z**: <1.8 = distress zone, 1.8–3.0 = grey zone, >3.0 = safe.
- **Piotroski F**: ≤3 = weak fundamentals, 7–9 = strong.
- For financial sector stocks, ignore debt ratios — focus on ROE and efficiency.

### 3. Valuation

Always evaluate valuation RELATIVE TO SECTOR, not with absolute thresholds.

- **Price/FCF**: calculate as market_cap / free_cash_flow. <15 is attractive, 15–25 is fair, >30 is paying a premium. This is the single most important valuation metric — prioritize it.
- **P/E vs sector context**: state trailing PE and whether it looks high or low for this industry.
- **PEG ratio**: <1.0 is genuinely cheap for the growth rate, 1.0–1.5 is reasonable, >2.0 is expensive.
- **EV/EBITDA**: captures debt. Compare to sector norms.
- **Analyst targets**: calculate upside/downside to mean target. Wide spread = high uncertainty.
- **Price vs 52-week range**: near the low = potential value, near the high = less margin of safety.

### 4. Growth Assessment

- **Revenue CAGR**: >10% is solid, >20% is strong, negative is a concern.
- **EPS trajectory**: compare forward_eps to trailing_eps. Growing EPS with stable share count is ideal.
- **Historical consistency**: look across the annual history. Consistent growth deserves a premium; one-off spikes don't.
- **Growth vs valuation**: is the growth rate sufficient to justify current multiples?

### 5. Risk Assessment

Identify the top 3 specific risks. Be concrete, not generic. Examples:
- "Revenue concentration: 38% of revenue comes from a single product line"
- "Margin compression: operating margin fell from 28% to 21% over 3 years"
- "Debt maturity wall: $12B in debt with only $3B cash"
- "Insider selling: 3 executives sold shares in the last quarter"
- "Short interest at 8% of float suggests meaningful bearish conviction"

Always end risks with an explicit "I'm wrong if..." condition — the single
most important thing that would invalidate the bullish or bearish thesis.

## Web Context

After running the five lenses above, search the web for recent news on the ticker:
- Recent earnings results or guidance changes
- Major product launches, partnerships, or competitive threats
- Regulatory or legal developments
- Macroeconomic factors specific to this sector

Integrate findings into the risk section and bottom line.

## Scoring

Assign a composite score from 0–100:

| Pillar     | Weight | What scores high                                              |
|------------|--------|---------------------------------------------------------------|
| Quality    | 40%    | High ROIC, strong margins, low debt, consistent positive FCF, high Piotroski F |
| Valuation  | 35%    | Below-sector PE, PEG <1.5, P/FCF <20, analyst upside >15%    |
| Growth     | 25%    | Revenue CAGR >10%, growing EPS, positive forward trajectory   |

Score each pillar 0–100 independently, then compute the weighted average.

Verdict thresholds:
- **75–100**: STRONG BUY
- **60–74**: BUY
- **45–59**: HOLD
- **0–44**: PASS

Confidence level:
- **HIGH**: ≤2 key fields null
- **MEDIUM**: 3–5 key fields null
- **LOW**: >5 key fields null

## Save the Report

After generating the memo, save it to the reports table:

```bash
python3 -c "
import sqlite3, json
from datetime import datetime, timezone
conn = sqlite3.connect('/workspace/group/investments.db')
conn.execute('''INSERT INTO reports (report_type, tickers, generated_at, recommendation, content)
               VALUES (?,?,?,?,?)''',
    ('due_diligence', 'TICKER', datetime.now(timezone.utc).isoformat(),
     'VERDICT_LOWERCASE', '''FULL_MEMO_TEXT'''))
conn.commit()
conn.close()
"
```

## Output Format

Deliver in Telegram markdown:

```
📊 **{COMPANY} ({TICKER})** — DD Report

**Verdict:** {VERDICT} | **Score:** {X}/100 | **Confidence:** {LEVEL}

🏢 **BUSINESS**
[What they do. Moat assessment. 2–3 sentences.]

💰 **FINANCIAL HEALTH**
[Debt, liquidity, FCF quality. Flag red flags. 2–3 sentences.]

📉 **VALUATION**
[Cheap or expensive vs sector? Key multiples. 2–3 sentences.]

📈 **GROWTH**
[Revenue & earnings trend. Sustainable? 2–3 sentences.]

⚠️ **RISKS**
• [Risk 1]
• [Risk 2]
• [Risk 3]
• I'm wrong if: [thesis-breaker]

🎯 **BOTTOM LINE**
[2 sentences: buy/hold/pass and at what price it becomes interesting if not now.]
```

## Important Guidelines

- Never hype. If the numbers are mediocre, say so.
- When data is null, explicitly note it and lower confidence.
- Don't invent data. If historical financials aren't available, say so.
- Sector context matters enormously for valuation.
- For REITs, note that high debt is structural.
- This is research to inform the user's decision, not financial advice.
```

- [ ] **Step 2: Commit**

```bash
git add container/skills/stock-screener/SKILL-dd.md
git commit -m "feat(stock-suite): add SKILL-dd.md DD analysis framework"
```

---

## Task 11: Update SKILL.md, DOCS.md, and Default DB Paths

**Files:**
- Modify: `container/skills/stock-screener/SKILL.md`
- Modify: `container/skills/stock-screener/DOCS.md`
- Modify: `container/skills/stock-screener/stock_screener.py:206`
- Modify: `container/skills/stock-screener/query_stocks.py:22`

- [ ] **Step 1: Update DEFAULT_DB in `stock_screener.py`**

In `container/skills/stock-screener/stock_screener.py`, change line 206:

```python
# Before:
DEFAULT_DB       = Path("/workspace/group/stock_screener.db")

# After:
DEFAULT_DB       = Path("/workspace/group/investments.db")
```

- [ ] **Step 2: Update DEFAULT_DB in `query_stocks.py`**

In `container/skills/stock-screener/query_stocks.py`, change line 22:

```python
# Before:
DEFAULT_DB    = Path("/workspace/group/stock_screener.db")

# After:
DEFAULT_DB    = Path("/workspace/group/investments.db")
```

- [ ] **Step 3: Append new command triggers to `SKILL.md`**

Append the following section to the end of `container/skills/stock-screener/SKILL.md`:

```markdown
---

# Due Diligence

Produce a structured investment memo for one or more tickers from the shortlist.

## Trigger
- `DD on AAPL`, `analyze TSLA`, `should I buy MSFT?`, `investment memo for GOOG`, `research X`

## How to use

**Step 1 — fetch DD data:**

```bash
python3 /home/node/.claude/skills/stock-screener/due_diligence.py \
  --tickers <TICKERS> \
  --db /workspace/group/investments.db
```

**Step 2 — apply the DD framework:**

Load `SKILL-dd.md` and follow its analysis framework to produce the investment memo.

**Step 3 — search for recent news:**

Web-search for recent news on each ticker (earnings, product launches, regulatory events). Integrate findings into the risk section.

**Step 4 — save the report:**

Insert the completed memo into the `reports` table (see SKILL-dd.md for the exact INSERT command).

## Notes
- Run `/screen-stocks` first to ensure the ticker is in the DB before running DD.
- If a field is null in the JSON, note it explicitly and lower confidence.

---

# Technical Analysis

Assess the entry point for one or more tickers.

## Trigger
- `technical entry for AAPL`, `is now a good time to buy NVDA?`, `entry point for TSLA in the next 2 weeks`, `chart MSFT`

## How to use

Parse the user's message to extract the horizon (default: `2w`):
- "next week" → `1w`
- "next 2 weeks" / "couple of weeks" → `2w`
- "next month" → `1m`
- "next quarter" / "3 months" → `3m`

```bash
python3 /home/node/.claude/skills/stock-screener/technical_analysis.py \
  --tickers <TICKERS> \
  --db /workspace/group/investments.db \
  --horizon <HORIZON>
```

Report the `entry_zone`, `key_levels`, and `summary` from the JSON output. Format as a concise Telegram message. Save to `reports` with `report_type = 'technical'`.

---

# Portfolio Manager

Review your portfolio holdings and receive per-holding recommendations.

## Triggers

### Show portfolio (summary only, no full review)
- `show my portfolio`, `what do I own?`, `list my holdings`

```bash
python3 /home/node/.claude/skills/stock-screener/portfolio_manager.py \
  --db /workspace/group/investments.db
```

Report the `portfolio_summary` and holdings table. Do not do web search for a plain show.

### Full portfolio review (with news + macro context)
- `review my portfolio`, `how are my holdings doing?`, `portfolio check`

1. First refresh prices for all holdings:
```bash
python3 /home/node/.claude/skills/stock-screener/stock_screener.py \
  --tickers <ALL_HELD_TICKERS> \
  --db /workspace/group/investments.db \
  --delay 0.5
```
2. Run portfolio_manager.py (as above)
3. Web-search recent news for each holding (last 2 weeks)
4. Fetch macro context: 10-year Treasury yield, VIX level, relevant sector ETF performance
5. For each holding issue: HOLD / TRIM / ADD / EXIT with one-line rationale
6. Save full review to `reports` with `report_type = 'portfolio_review'`

### Add / update a holding
- `I bought 50 AAPL at $175 on Jan 15`
- `add MSFT to my portfolio: 20 shares at $380 bought Feb 1`

```python
import sqlite3, migrate_db, portfolio_manager as pm
from pathlib import Path
conn = sqlite3.connect('/workspace/group/investments.db')
migrate_db.ensure_new_tables(conn)
pm.upsert_holding(conn, 'TICKER', shares=N, avg_buy_price=P, buy_date='YYYY-MM-DD')
conn.close()
```

### Remove a holding
- `I sold all my AAPL`, `remove TSLA from my portfolio`

```python
import sqlite3, portfolio_manager as pm
conn = sqlite3.connect('/workspace/group/investments.db')
pm.delete_holding(conn, 'TICKER')
conn.close()
```

### Partial sale (reduce shares)
- `I sold 20 of my 50 AAPL shares`

Use `upsert_holding` with the new reduced share count and the same avg_buy_price.

### Query past reports
- `show my last DD on AAPL`, `what did you recommend for TSLA last month?`

```bash
python3 /home/node/.claude/skills/stock-screener/query_stocks.py \
  --db /workspace/group/investments.db \
  --sql "SELECT generated_at, report_type, recommendation, content FROM reports WHERE tickers LIKE '%AAPL%' ORDER BY generated_at DESC LIMIT 3"
```

## Notes
- DB path has changed from `stock_screener.db` → `investments.db`. The migrate_db.py script handles the rename automatically at startup.
```

- [ ] **Step 4: Update `DOCS.md` with the new tables**

Append to `container/skills/stock-screener/DOCS.md`:

```markdown

---

## New Tables (Stock Investment Suite)

### `portfolio_holdings`

One row per portfolio position. Managed conversationally via the agent.

| Column | Type | Notes |
|--------|------|-------|
| ticker | TEXT PK | Uppercase ticker symbol |
| shares | REAL | Current number of shares held |
| avg_buy_price | REAL | Average cost basis per share |
| buy_date | TEXT | ISO 8601 date of initial purchase |
| currency | TEXT | ISO 4217 code, default 'USD' |
| notes | TEXT | Optional thesis note |
| last_updated | TEXT | ISO 8601 UTC timestamp |

### `reports`

Persists every recommendation the agent generates. Enables historical queries
and lets the portfolio manager reference prior DD scores.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK AUTOINCREMENT | |
| report_type | TEXT | `due_diligence`, `technical`, `portfolio_review` |
| tickers | TEXT | Comma-separated ticker list |
| generated_at | TEXT | ISO 8601 UTC |
| recommendation | TEXT | `buy`, `hold`, `sell`, `watch`, `entry_now`, `wait` |
| content | TEXT | Full narrative report in Telegram markdown |
| agent_notes | TEXT | Optional free-form follow-up |

Example query — last 3 DD reports:
```sql
SELECT ticker, generated_at, recommendation
FROM reports
WHERE report_type = 'due_diligence'
ORDER BY generated_at DESC
LIMIT 3;
```
```

- [ ] **Step 5: Run the full test suite one more time**

```bash
python3 -m pytest container/skills/stock-screener/ -v
```

Expected: All tests PASSED.

- [ ] **Step 6: Commit**

```bash
git add container/skills/stock-screener/SKILL.md \
        container/skills/stock-screener/DOCS.md \
        container/skills/stock-screener/stock_screener.py \
        container/skills/stock-screener/query_stocks.py
git commit -m "feat(stock-suite): update SKILL.md, DOCS.md, and default DB paths"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Covered by task |
|---|---|
| DB rename stock_screener.db → investments.db | Task 1 |
| portfolio_holdings table | Task 1 |
| reports table | Task 1 |
| due_diligence.py — DB fundamentals extraction | Task 2 |
| due_diligence.py — supplementary Yahoo Finance fetch | Task 3 |
| due_diligence.py — CLI + JSON output | Task 4 |
| technical_analysis.py — all indicators (SMA, EMA, RSI, MACD, BB, ATR, volume, 52w) | Task 5 |
| technical_analysis.py — entry zone, support/resistance, horizon, CLI | Task 6 |
| portfolio_manager.py — CRUD | Task 7 |
| portfolio_manager.py — compute_portfolio + CLI | Task 8 |
| SKILL-dd.md with full DD framework | Task 10 |
| SKILL.md new triggers (DD, technical, portfolio) | Task 11 |
| DOCS.md new tables documented | Task 11 |
| DEFAULT_DB path updated in existing scripts | Task 11 |

**No placeholders detected.** All code steps contain full implementations.

**Type consistency verified:** `_read_db_fundamentals` returns the exact keys that `_merge_supplementary` expects. `compute_portfolio` calls `list_holdings` which returns the exact dict structure it iterates. `upsert_holding` / `delete_holding` are called consistently by tests and `main()`.
