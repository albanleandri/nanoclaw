# Macro Analyst Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone macro analyst agent that evaluates the macroeconomic environment (global + sector-specific) and injects a `🌍 MACRO CONTEXT` section into DD memos as a pre-flight step.

**Architecture:** New `macro-analyst` agent follows the same thin-orchestrator pattern as `stock-dd-writer` and `stock-technical-analyst` — analysis logic lives in a checklist reference file, output format lives in a template, the agent file itself just wires them together. The coordinator SKILL.md runs the macro agent before the DD writer and injects the macro snapshot into the DD writer's input.

**Tech Stack:** Markdown agent definitions, web search (no new Python scripts). All existing Python scripts and DB schema unchanged.

---

## File Map

| Action | File | Purpose |
|---|---|---|
| Create | `container/skills/stock-market-investing/templates/macro-template.md` | Telegram output format for macro reports |
| Create | `container/skills/stock-market-investing/references/macro-analysis-checklist.md` | Analysis logic — extend this file over time |
| Create | `container/skills/agents/macro-analyst.md` | Agent definition — thin orchestration only |
| Modify | `container/skills/stock-market-investing-reference/SKILL.md` | Add macro template + checklist to path table |
| Modify | `container/skills/stock-market-investing/templates/due-diligence-template.md` | Add `🌍 MACRO CONTEXT` section between RISKS and BOTTOM LINE |
| Modify | `container/skills/agents/stock-dd-writer.md` | Accept optional `MACRO_SNAPSHOT:` input block |
| Modify | `container/skills/stock-market-investing/SKILL.md` | Add macro routing + standalone section + DD pre-flight step |

---

## Task 1: Create the macro output template

**Files:**
- Create: `container/skills/stock-market-investing/templates/macro-template.md`

- [ ] **Step 1: Create the template file**

```markdown
# Macro Environment Report — Output Template

Format the report in Telegram markdown:
- `*bold*` — single asterisks (not double `**`)
- `_italic_` — underscores
- `•` — bullet character (not `-`)
- No `##` headings
- No bare URLs

## Structure

When a sector is known (ticker was provided):

```
🌍 *MACRO ENVIRONMENT* — {SECTOR}

*Verdict:* {TAILWIND|NEUTRAL|HEADWIND}

🏦 *GLOBAL CONDITIONS*
[Rate environment — current Fed funds rate and stance. Yield curve shape. VIX level. USD direction. 2–3 sentences with actual numbers.]

📊 *SECTOR CONTEXT*
[Sector ETF trend vs S&P 500. Top 2–3 sector-specific tailwinds or headwinds. 2–3 sentences with actual numbers or recent events.]

⚡ *KEY FACTORS*
• [Specific factor 1 with data point]
• [Specific factor 2 with data point]
• [Specific factor 3 with data point]

🎯 *BOTTOM LINE*
[One sentence: what this macro environment means for investors in this sector right now and what would change the verdict.]
```

When no sector is known (standalone, no ticker):

```
🌍 *MACRO ENVIRONMENT* — Global

*Verdict:* {TAILWIND|NEUTRAL|HEADWIND}

🏦 *GLOBAL CONDITIONS*
[Rate environment — current Fed funds rate and stance. Yield curve shape. VIX level. USD direction. CPI trend. 3–4 sentences with actual numbers.]

⚡ *KEY FACTORS*
• [Specific factor 1 with data point]
• [Specific factor 2 with data point]
• [Specific factor 3 with data point]

🎯 *BOTTOM LINE*
[One sentence: what this macro environment means for broad equity investors right now.]
```

## Required output header

Before the report, always include these two lines so the coordinator can parse metadata:

```
MACRO_VERDICT: <verdict_uppercase>
SECTOR: <sector_name or GLOBAL>

<report starts here>
```

`verdict_uppercase` must be one of: `TAILWIND`, `NEUTRAL`, `HEADWIND`
```

- [ ] **Step 2: Verify the file exists**

```bash
ls container/skills/stock-market-investing/templates/
```

Expected: `due-diligence-template.md  macro-template.md  technical-template.md`

- [ ] **Step 3: Commit**

```bash
git add container/skills/stock-market-investing/templates/macro-template.md
git commit -m "feat: add macro report output template"
```

---

## Task 2: Create the macro analysis checklist

**Files:**
- Create: `container/skills/stock-market-investing/references/macro-analysis-checklist.md`

- [ ] **Step 1: Create the checklist file**

```markdown
# Macro Analysis Checklist

This file defines the analysis logic for the macro analyst agent. Extend it over time
to add new indicators, sector mappings, or data sources without touching the agent file.

---

## Step 1 — Determine scope

**If a ticker was provided:**
Search the web for `"<TICKER> company sector industry"` to identify the sector
(e.g., "Technology", "Financials", "Energy", "Healthcare"). Note the sector for Step 3.

**If no ticker was provided:**
Scope is GLOBAL. Skip Step 3. Omit the 📊 SECTOR CONTEXT section from the report.

---

## Step 2 — Fetch global conditions

Search the web for the current value of each indicator. Use the most recent data available.
Always include the actual number, not just the direction.

| Indicator | Search query | What to note |
|---|---|---|
| Fed stance + rate | `"Federal Reserve fed funds rate 2026"` | Current rate (e.g., 4.25%); stance: hiking / pausing / cutting; next move priced by markets |
| 10Y Treasury yield | `"10-year Treasury yield today"` | Absolute level (e.g., 4.6%); recent direction (rising / falling / stable) |
| Yield curve | `"2-year 10-year Treasury spread today"` | Positive spread = normal; negative = inverted (historical recession signal) |
| VIX | `"VIX volatility index today"` | <15 = calm; 15–25 = elevated; >25 = fear mode; >30 = stress |
| DXY USD index | `"DXY dollar index today"` | Level and direction; rising DXY = headwind for multinationals and commodity exporters |
| CPI trend | `"US CPI inflation latest 2026"` | Most recent reading; direction vs prior month; Fed target vs actual |

---

## Step 3 — Fetch sector-specific conditions

Use the sector from Step 1 to run the relevant search and extract the top 2–3 factors.

### Technology
- Search: `"technology sector macro outlook 2026 AI capex"`
- Key factors: AI capex spending cycle (hyperscaler guidance), semiconductor supply/demand, cloud spending growth, regulatory/antitrust risk
- Rate sensitivity: Growth stocks are duration-sensitive — rising rates compress multiples

### Financials (Banks, Insurance)
- Search: `"financials sector outlook interest rates 2026 bank"`
- Key factors: Net interest margin trend (benefits from higher rates), credit quality / loan default rates, yield curve slope (steeper = better for banks)
- Rate sensitivity: Moderate positive — higher rates boost NIM, but can hurt credit quality

### Energy
- Search: `"oil gas price outlook 2026 OPEC WTI Brent"`
- Key factors: WTI and Brent crude price, OPEC+ production decisions, natural gas prices (Henry Hub), energy transition policy
- Rate sensitivity: Low direct sensitivity; commodity price is the main driver

### Healthcare (Pharma, Biotech, Devices)
- Search: `"healthcare sector outlook 2026 drug pricing FDA"`
- Key factors: Drug pricing regulation / Medicare negotiation pipeline, FDA approval sentiment, patent cliff exposure, M&A environment
- Rate sensitivity: Defensive — relatively rate-insensitive

### Consumer Discretionary / Retail
- Search: `"consumer discretionary retail sector outlook 2026 consumer spending"`
- Key factors: Consumer confidence index, real wage growth vs inflation, credit card delinquency rates, housing market activity
- Rate sensitivity: High — consumers sensitive to borrowing costs and employment

### Consumer Staples
- Search: `"consumer staples sector outlook 2026 inflation pricing"`
- Key factors: Input cost inflation (commodities, packaging, freight), pricing power vs private label competition, volume vs price mix
- Rate sensitivity: Low-moderate defensive; pricing power matters more than rate direction

### Industrials / Materials
- Search: `"industrials sector outlook 2026 tariffs manufacturing PMI"`
- Key factors: ISM Manufacturing PMI, tariff and trade policy developments, infrastructure spending, reshoring trends
- Rate sensitivity: Moderate — sensitive to capex spending cycles and credit conditions

### Real Estate / REITs
- Search: `"REIT sector outlook interest rates 2026 commercial residential"`
- Key factors: 10Y Treasury yield direction (high correlation), mortgage rate level, commercial vs residential split, occupancy and rent trends
- Rate sensitivity: Very high — REITs are long-duration assets; rising rates are a direct headwind

### Utilities
- Search: `"utilities sector outlook 2026 interest rates renewable energy"`
- Key factors: Rate direction (utilities behave like bonds), renewable energy policy / IRA status, electricity demand growth (AI data centers), regulatory environment
- Rate sensitivity: Very high — rising rates make dividend yields less attractive

### Communication Services / Media
- Search: `"communication services sector outlook 2026 advertising streaming"`
- Key factors: Digital advertising spend cycle, streaming competition and subscriber trends, telecom capex cycle
- Rate sensitivity: Moderate — ad-driven companies are cyclical; telcos are rate-sensitive

### For any other sector:
Search: `"<sector> sector macro tailwinds headwinds outlook 2026"` and extract the top 2–3 concrete factors.

---

## Step 4 — Assign the verdict

Weigh the evidence and assign one of three verdicts:

**TAILWIND** — macro conditions are actively supportive:
- Rates moving in the right direction for this sector
- Sector ETF outperforming or recovering vs S&P 500
- Key sector inputs (commodity prices, capex, consumer spending) are favorable
- No major policy, regulatory, or trade headwinds

**NEUTRAL** — mixed signals:
- Some factors support, others constrain
- Rate environment is stable but not helpful
- Sector performing in line with market; no clear catalyst in either direction
- Use this when the evidence is genuinely balanced, not as a default

**HEADWIND** — macro conditions are a net drag:
- Rising rates compressing multiples (especially for growth and rate-sensitive sectors)
- Sector ETF underperforming the market over the past quarter
- Key input costs rising, demand softening, or major policy pressure
- USD strength hurting international revenues (for multinationals)

When evidence is split between two levels, state both and explain what would tip the balance.

---

## Guidelines

- Use actual numbers, not vague language. "The Fed funds rate is at 4.5%, with one cut priced for H2 2026" is better than "rates are elevated."
- Distinguish cyclical timing from structural trends. A structural tailwind (e.g., AI adoption for semiconductors) is different from a cyclical one (e.g., Fed rate cut).
- A HEADWIND verdict does not mean "don't invest" — it means margin of safety should be higher and timing matters more.
- When data is unavailable or search returns outdated information, note it explicitly and lower the confidence of the verdict.
```

- [ ] **Step 2: Verify the file exists**

```bash
ls container/skills/stock-market-investing/references/
```

Expected: `due-diligence-checklist.md  macro-analysis-checklist.md  recommendation-rules.md  screener-schema.md  technical-analysis-checklist.md`

- [ ] **Step 3: Commit**

```bash
git add container/skills/stock-market-investing/references/macro-analysis-checklist.md
git commit -m "feat: add macro analysis checklist with sector mappings"
```

---

## Task 3: Create the macro analyst agent

**Files:**
- Create: `container/skills/agents/macro-analyst.md`

- [ ] **Step 1: Create the agent file**

```markdown
---
name: macro-analyst
description: >
  Macroeconomic environment analyst. Produces a global + sector-specific macro report
  with a TAILWIND / NEUTRAL / HEADWIND verdict. Use standalone or as DD pre-flight context.
  Input: optional Ticker or Sector.
---

# Macro Analyst

You are a specialist macroeconomic analyst. Your only job is to produce a complete
macro environment report. You do not own delivery or persistence — return the full
artifact and nothing else.

## Input

You will receive a message containing one of:
- `Ticker: <TICKER>` — infer sector from ticker; full two-layer analysis (global + sector)
- `Sector: <SECTOR>` — full two-layer analysis for the named sector
- Neither — global conditions only; no sector layer

## Step 1 — Analyse

Follow the checklist in:
`/home/node/.claude/skills/stock-market-investing/references/macro-analysis-checklist.md`

Work through all steps in order:
1. Determine scope (ticker → infer sector via web, named sector, or GLOBAL)
2. Fetch global conditions (Step 2 of checklist)
3. Fetch sector-specific conditions if applicable (Step 3 of checklist)
4. Assign TAILWIND / NEUTRAL / HEADWIND verdict (Step 4 of checklist)

## Step 2 — Format

Use the template in:
`/home/node/.claude/skills/stock-market-investing/templates/macro-template.md`

For shared Telegram markdown conventions, consult:
`/home/node/.claude/skills/stock-market-investing-reference/SKILL.md`

## Step 3 — Return

Your response MUST start with exactly these two header lines, then a blank line,
then the full report:

```
MACRO_VERDICT: <verdict_uppercase>
SECTOR: <sector_name or GLOBAL>

<full report in Telegram markdown>
```

`verdict_uppercase` must be one of: `TAILWIND`, `NEUTRAL`, `HEADWIND`

## Non-goals

- Do NOT call `mcp__nanoclaw__send_message`
- Do NOT call `save_report.py`
- Do NOT return a session summary or a short confirmation
- Do NOT ask clarifying questions — work with what you have
- Do NOT return anything other than the structured output above
```

- [ ] **Step 2: Verify the file exists**

```bash
ls container/skills/agents/
```

Expected: `macro-analyst.md  stock-dd-writer.md  stock-technical-analyst.md`

- [ ] **Step 3: Commit**

```bash
git add container/skills/agents/macro-analyst.md
git commit -m "feat: add macro-analyst agent definition"
```

---

## Task 4: Update the shared reference skill with macro paths

**Files:**
- Modify: `container/skills/stock-market-investing-reference/SKILL.md`

Current **Reference file paths** table ends at:
```
| TA template | `/home/node/.claude/skills/stock-market-investing/templates/technical-template.md` |
```

- [ ] **Step 1: Add macro paths to the reference file paths table**

In `container/skills/stock-market-investing-reference/SKILL.md`, find the **Reference file paths** table and append two rows:

```markdown
| Macro checklist | `/home/node/.claude/skills/stock-market-investing/references/macro-analysis-checklist.md` |
| Macro template | `/home/node/.claude/skills/stock-market-investing/templates/macro-template.md` |
```

The full updated table should read:

```markdown
## Reference file paths

| Purpose | Path |
|---|---|
| DB schema | `/home/node/.claude/skills/stock-market-investing/references/screener-schema.md` |
| DD checklist | `/home/node/.claude/skills/stock-market-investing/references/due-diligence-checklist.md` |
| TA checklist | `/home/node/.claude/skills/stock-market-investing/references/technical-analysis-checklist.md` |
| Recommendation rules | `/home/node/.claude/skills/stock-market-investing/references/recommendation-rules.md` |
| DD template | `/home/node/.claude/skills/stock-market-investing/templates/due-diligence-template.md` |
| TA template | `/home/node/.claude/skills/stock-market-investing/templates/technical-template.md` |
| Macro checklist | `/home/node/.claude/skills/stock-market-investing/references/macro-analysis-checklist.md` |
| Macro template | `/home/node/.claude/skills/stock-market-investing/templates/macro-template.md` |
```

- [ ] **Step 2: Run the existing path tests to verify nothing is broken**

```bash
cd /home/nanoclaw/nanoclaw
python3 -m pytest container/skills/test_skill_paths.py -v
```

Expected: all tests pass (the test only checks `.py` script paths in SKILL.md files, so new markdown paths won't cause failures — but run it to catch any regressions).

- [ ] **Step 3: Commit**

```bash
git add container/skills/stock-market-investing-reference/SKILL.md
git commit -m "feat: add macro checklist and template paths to shared reference"
```

---

## Task 5: Add `macro_context` to save_report.py and write its test

**Files:**
- Modify: `container/skills/stock-market-investing/save_report.py`
- Create: `container/skills/stock-market-investing/test_save_report.py`

`save_report.py` uses `choices=VALID_TYPES` on the `--type` argument. The current tuple is
`("due_diligence", "technical", "portfolio_review")`. Passing `macro_context` would fail with
an argparse error. This task adds the new type and tests it.

- [ ] **Step 1: Write the failing test**

Create `container/skills/stock-market-investing/test_save_report.py`:

```python
"""Tests for save_report.py"""
import sqlite3
from pathlib import Path
import pytest
import sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import save_report


def make_reports_db(tmp_path: Path) -> Path:
    db = tmp_path / "investments.db"
    conn = sqlite3.connect(db)
    conn.executescript("""
        CREATE TABLE reports (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            report_type     TEXT NOT NULL,
            tickers         TEXT NOT NULL,
            generated_at    TEXT NOT NULL,
            recommendation  TEXT,
            content         TEXT NOT NULL,
            agent_notes     TEXT
        );
    """)
    conn.commit()
    conn.close()
    return db


def test_save_due_diligence(tmp_path):
    db = make_reports_db(tmp_path)
    rc = save_report.main([
        "--db", str(db),
        "--type", "due_diligence",
        "--tickers", "AAPL",
        "--recommendation", "buy",
        "--content", "Test memo",
    ])
    assert rc == 0
    conn = sqlite3.connect(db)
    row = conn.execute("SELECT report_type, tickers, recommendation FROM reports").fetchone()
    conn.close()
    assert row == ("due_diligence", "AAPL", "buy")


def test_save_macro_context(tmp_path):
    db = make_reports_db(tmp_path)
    rc = save_report.main([
        "--db", str(db),
        "--type", "macro_context",
        "--tickers", "Technology",
        "--recommendation", "headwind",
        "--content", "🌍 *MACRO ENVIRONMENT* — Technology\n\n*Verdict:* HEADWIND",
    ])
    assert rc == 0
    conn = sqlite3.connect(db)
    row = conn.execute("SELECT report_type, tickers, recommendation FROM reports").fetchone()
    conn.close()
    assert row == ("macro_context", "Technology", "headwind")


def test_invalid_type_rejected(tmp_path):
    db = make_reports_db(tmp_path)
    with pytest.raises(SystemExit):
        save_report.main([
            "--db", str(db),
            "--type", "invalid_type",
            "--tickers", "AAPL",
            "--content", "memo",
        ])
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd /home/nanoclaw/nanoclaw/container/skills/stock-market-investing
python3 -m pytest test_save_report.py::test_save_macro_context -v
```

Expected: FAIL — `invalid choice: 'macro_context'`

- [ ] **Step 3: Add `macro_context` to VALID_TYPES in save_report.py**

In `container/skills/stock-market-investing/save_report.py`, find:

```python
VALID_TYPES = ("due_diligence", "technical", "portfolio_review")
```

Replace with:

```python
VALID_TYPES = ("due_diligence", "technical", "portfolio_review", "macro_context")
```

- [ ] **Step 4: Run all save_report tests to confirm they pass**

```bash
cd /home/nanoclaw/nanoclaw/container/skills/stock-market-investing
python3 -m pytest test_save_report.py -v
```

Expected:
```
PASSED test_save_report.py::test_save_due_diligence
PASSED test_save_report.py::test_save_macro_context
PASSED test_save_report.py::test_invalid_type_rejected
```

- [ ] **Step 5: Commit**

```bash
git add container/skills/stock-market-investing/save_report.py \
        container/skills/stock-market-investing/test_save_report.py
git commit -m "feat: add macro_context to save_report valid types with tests"
```

---

## Task 6: Update the DD template and DD writer to accept macro snapshot

**Files:**
- Modify: `container/skills/stock-market-investing/templates/due-diligence-template.md`
- Modify: `container/skills/agents/stock-dd-writer.md`

### Part A — Update the DD template

The current DD template structure ends with `⚠️ *RISKS*` then `🎯 *BOTTOM LINE*`. Add the macro section between them.

- [ ] **Step 1: Update due-diligence-template.md**

Find the structure block in `container/skills/stock-market-investing/templates/due-diligence-template.md`. The current structure is:

```
⚠️ *RISKS*
• [Risk 1]
• [Risk 2]
• [Risk 3]
• I'm wrong if: [thesis-breaker]

🎯 *BOTTOM LINE*
[2 sentences: buy/hold/pass and at what price it becomes interesting if not now.]
```

Replace it with:

```
⚠️ *RISKS*
• [Risk 1]
• [Risk 2]
• [Risk 3]
• I'm wrong if: [thesis-breaker]

🌍 *MACRO CONTEXT*
[Insert MACRO_SNAPSHOT block verbatim here — the full macro report text, starting from
the first line after the stripped headers. If no MACRO_SNAPSHOT was provided, omit this
section entirely.]

🎯 *BOTTOM LINE*
[2 sentences: buy/hold/pass and at what price it becomes interesting if not now.]
```

### Part B — Update stock-dd-writer.md

- [ ] **Step 2: Update the Input section of stock-dd-writer.md**

Find the **Input** section in `container/skills/agents/stock-dd-writer.md`:

```markdown
## Input

You will receive a message containing:
- `Ticker: <TICKER>` — the stock to analyse
- `DB: <path>` — path to the investments database
- Optionally: user context (e.g. "I already own this", "thinking of adding")
```

Replace with:

```markdown
## Input

You will receive a message containing:
- `Ticker: <TICKER>` — the stock to analyse
- `DB: <path>` — path to the investments database
- `MACRO_SNAPSHOT: <block>` — (optional) pre-fetched macro environment report block
- Optionally: user context (e.g. "I already own this", "thinking of adding")
```

- [ ] **Step 3: Update the Format step of stock-dd-writer.md**

Find **Step 3 — Format** in `container/skills/agents/stock-dd-writer.md`:

```markdown
## Step 3 — Format

Use the template in:
`/home/node/.claude/skills/stock-market-investing/templates/due-diligence-template.md`
```

Replace with:

```markdown
## Step 3 — Format

Use the template in:
`/home/node/.claude/skills/stock-market-investing/templates/due-diligence-template.md`

If a `MACRO_SNAPSHOT:` block was provided in the input, insert its full text as the
`🌍 MACRO CONTEXT` section between RISKS and BOTTOM LINE. Do not re-fetch or re-analyse
macro conditions — use only what was provided.

If no `MACRO_SNAPSHOT:` was provided, omit the `🌍 MACRO CONTEXT` section entirely.
The score and verdict are not affected by the macro snapshot.
```

- [ ] **Step 4: Run the path tests**

```bash
cd /home/nanoclaw/nanoclaw
python3 -m pytest container/skills/test_skill_paths.py -v
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add container/skills/stock-market-investing/templates/due-diligence-template.md \
        container/skills/agents/stock-dd-writer.md
git commit -m "feat: dd writer accepts optional MACRO_SNAPSHOT input and renders macro section"
```

---

## Task 7: Update the coordinator SKILL.md

**Files:**
- Modify: `container/skills/stock-market-investing/SKILL.md`

This task has three parts: add macro to the routing table, add a standalone Macro section, and update the DD section to add the pre-flight step.

### Part A — Routing table

- [ ] **Step 1: Add macro row to the routing table**

Find the **Routing Rule** section in `container/skills/stock-market-investing/SKILL.md`:

```markdown
| If the message contains… | Use section |
|--------------------------|-------------|
| `DD`, `due diligence`, `investment memo`, `research`, `analyze [ticker]`, `should I buy` | **Due Diligence** |
| `entry point`, `entry for`, `technical`, `chart`, `good time to buy`, `timing`, `TA` | **Technical Analysis** |
```

Replace with:

```markdown
| If the message contains… | Use section |
|--------------------------|-------------|
| `DD`, `due diligence`, `investment memo`, `research`, `analyze [ticker]`, `should I buy` | **Due Diligence** |
| `entry point`, `entry for`, `technical`, `chart`, `good time to buy`, `timing`, `TA` | **Technical Analysis** |
| `macro`, `macro check`, `macro environment`, `macro context`, `macro for` | **Macro** |
```

### Part B — Add standalone Macro section

- [ ] **Step 2: Add a new Macro section after the Technical Analysis section**

Insert the following block after the Technical Analysis section and before the Portfolio Manager section:

```markdown
---

# Macro

Analyse the current macroeconomic environment, globally or for a specific sector.

## Triggers
- `macro check`, `macro environment`, `what's the macro right now?`
- `macro for tech`, `macro for energy`, `macro for [sector]`
- `macro on AAPL` (sector inferred from ticker)

## How to use

1. **Parse the request.** Extract ticker or sector if mentioned. If neither, scope is global.

2. **Invoke the macro-analyst subagent** using the Task tool with agent `macro-analyst`:

   ```
   Ticker: <TICKER>        ← if ticker mentioned
   Sector: <SECTOR>        ← if sector mentioned without ticker
                           ← leave empty if global check
   ```

3. **Parse the result.** The subagent output starts with two header lines:

   ```
   MACRO_VERDICT: <verdict>
   SECTOR: <sector_name or GLOBAL>
   ```

   Strip those two lines and the blank line that follows. The remaining text is the full report.

4. **Save the report:**

   ```bash
   python3 /home/node/.claude/skills/stock-market-investing/save_report.py \
     --db /workspace/group/investments.db \
     --type macro_context \
     --tickers "<sector_name or GLOBAL>" \
     --recommendation "<verdict_lowercase>" \
     --content "<full_report>"
   ```

   `verdict_lowercase` is the `MACRO_VERDICT` value lowercased: `tailwind`, `neutral`, or `headwind`.

5. **Send to Telegram:**

   Call `mcp__nanoclaw__send_message` with the full report as the `message` parameter.

6. **Return** a short confirmation: `Macro check complete — <verdict> for <sector_name or GLOBAL>.`
```

### Part C — Update the DD section to add pre-flight macro step

- [ ] **Step 3: Update the Due Diligence section**

Find the **Due Diligence** section's **How to use** block. The current block starts with:

```markdown
1. **Ensure ticker is in DB.** If the ticker has no screener data, run `stock_screener.py` first.

2. **Invoke the DD subagent** using the Task tool with agent `stock-dd-writer`:

   ```
   Ticker: <TICKER>
   DB: /workspace/group/investments.db
   <any user context, e.g. "I already own this">
   ```

3. **Parse the result.** The subagent output starts with two header lines:

   ```
   RECOMMENDATION: <verdict>
   TICKERS: <TICKER>
   ```

   Strip those two lines and the blank line that follows. The remaining text is the full memo.

4. **Save the report:**

   ```bash
   python3 /home/node/.claude/skills/stock-market-investing/save_report.py \
     --db /workspace/group/investments.db \
     --type due_diligence \
     --tickers <TICKER> \
     --recommendation <verdict> \
     --content "<full_memo>"
   ```

5. **Send to Telegram:**

   Call `mcp__nanoclaw__send_message` with the full memo as the `message` parameter.

6. **Return** a short confirmation: `DD complete for <TICKER> — saved as id=N.`
```

Replace with:

```markdown
1. **Ensure ticker is in DB.** If the ticker has no screener data, run `stock_screener.py` first.

2. **Invoke the macro-analyst subagent** using the Task tool with agent `macro-analyst`:

   ```
   Ticker: <TICKER>
   ```

3. **Parse the macro result.** The subagent output starts with two header lines:

   ```
   MACRO_VERDICT: <verdict>
   SECTOR: <sector_name>
   ```

   Strip those two lines and the blank line that follows. The remaining text is the macro snapshot.

4. **Invoke the DD subagent** using the Task tool with agent `stock-dd-writer`:

   ```
   Ticker: <TICKER>
   DB: /workspace/group/investments.db
   MACRO_SNAPSHOT: <macro snapshot text>
   <any user context, e.g. "I already own this">
   ```

5. **Parse the DD result.** The subagent output starts with two header lines:

   ```
   RECOMMENDATION: <verdict>
   TICKERS: <TICKER>
   ```

   Strip those two lines and the blank line that follows. The remaining text is the full memo.

6. **Save the report:**

   ```bash
   python3 /home/node/.claude/skills/stock-market-investing/save_report.py \
     --db /workspace/group/investments.db \
     --type due_diligence \
     --tickers <TICKER> \
     --recommendation <verdict> \
     --content "<full_memo>"
   ```

7. **Send to Telegram:**

   Call `mcp__nanoclaw__send_message` with the full memo as the `message` parameter.

8. **Return** a short confirmation: `DD complete for <TICKER> — saved as id=N.`
```

- [ ] **Step 4: Run the path tests**

```bash
cd /home/nanoclaw/nanoclaw
python3 -m pytest container/skills/test_skill_paths.py -v
```

Expected: all tests pass. The test checks that every `/home/node/.claude/skills/<skill>/<script>.py` path referenced in SKILL.md files exists on the host. The new macro sections reference no new `.py` scripts, so no new paths to validate.

- [ ] **Step 5: Run the full test suite**

```bash
cd /home/nanoclaw/nanoclaw
npm test
```

Expected: all tests pass. No TypeScript changes were made, so this is a regression check only.

- [ ] **Step 6: Commit**

```bash
git add container/skills/stock-market-investing/SKILL.md
git commit -m "feat: add macro routing, standalone macro section, and DD pre-flight to coordinator"
```

---

## Task 8: Rebuild and verify

- [ ] **Step 1: Rebuild the container image**

```bash
cd /home/nanoclaw/nanoclaw
npm run container:build
```

Expected: build completes without errors. The new files in `container/skills/` are COPY'd into the image.

- [ ] **Step 2: Restart the service**

```bash
npm run service:restart
```

- [ ] **Step 3: Verify service is running**

```bash
npm run service:status
```

Expected: service is active/running.

- [ ] **Step 4: Smoke test standalone macro (via Telegram)**

Send to the bot: `macro check`

Expected response: a Telegram message starting with `🌍 *MACRO ENVIRONMENT* — Global` with a TAILWIND/NEUTRAL/HEADWIND verdict, global conditions section, and bottom line. A report saved to the DB with `report_type = "macro_context"`.

- [ ] **Step 5: Smoke test sector-specific macro (via Telegram)**

Send to the bot: `macro for tech`

Expected response: macro report with `— Technology` in the header, includes a 📊 SECTOR CONTEXT section with AI/semiconductor factors.

- [ ] **Step 6: Smoke test DD with macro pre-flight (via Telegram)**

Send to the bot: `DD on MSFT` (MSFT should already be in DB; if not, run `/screen-stocks MSFT` first)

Expected response: full DD memo including a `🌍 MACRO CONTEXT` section between the RISKS and BOTTOM LINE sections. The composite score (e.g., `Score: 72/100`) should be unchanged from what a DD without macro would produce — macro is display-only.

- [ ] **Step 7: Final commit (if any fixups were needed during smoke test)**

```bash
git add -p
git commit -m "fix: smoke test fixups for macro analyst"
```

Only commit if fixes were needed. Skip if smoke tests passed clean.
