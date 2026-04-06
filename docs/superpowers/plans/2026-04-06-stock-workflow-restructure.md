# Stock Workflow Restructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the stock DD and TA flows into three clean layers — a coordinator skill that owns save/delivery, reference files that support reasoning, and specialized subagents that produce artifacts only.

**Architecture:** The coordinator `SKILL.md` routes to `Task stock-dd-writer` or `Task stock-technical-analyst`, receives the complete artifact, then calls `save_report.py` and `mcp__nanoclaw__send_message` itself. Subagents return structured output (two header lines + full text) and explicitly do not own delivery or persistence.

**Tech Stack:** TypeScript (vitest), Python, Markdown (Claude Code skill/agent format)

---

## File Map

| Action | Path |
|---|---|
| Modify | `src/container-runner.ts` — add agents sync loop after skills sync |
| Add test | `src/container-runner.test.ts` — agents sync behaviour |
| Create | `container/agents/stock-dd-writer.md` |
| Create | `container/agents/stock-technical-analyst.md` |
| Create | `container/skills/stock-market-investing/references/screener-schema.md` |
| Create | `container/skills/stock-market-investing/references/due-diligence-checklist.md` |
| Create | `container/skills/stock-market-investing/references/technical-analysis-checklist.md` |
| Create | `container/skills/stock-market-investing/references/recommendation-rules.md` |
| Create | `container/skills/stock-market-investing/templates/due-diligence-template.md` |
| Create | `container/skills/stock-market-investing/templates/technical-template.md` |
| Create | `container/skills/stock-market-investing-reference/SKILL.md` |
| Rewrite | `container/skills/stock-market-investing/SKILL.md` — DD and TA sections only |
| Delete | `container/skills/stock-market-investing/SKILL-dd.md` |
| Delete | `container/skills/stock-market-investing/SKILL-ta.md` |
| Delete | `container/skills/stock-market-investing/DOCS.md` |

---

## Task 1: Add agents sync to container-runner.ts

**Files:**
- Modify: `src/container-runner.ts:149-175` (after skills sync, before `mounts.push`)
- Test: `src/container-runner.test.ts`

- [ ] **Step 1: Add import for `fs` in test file and write two failing tests**

  At the top of `src/container-runner.test.ts`, after the existing imports, add:

  ```typescript
  import fs from 'fs';
  ```

  Then add a new `describe` block at the end of the file (after the existing
  `describe('container-runner timeout behavior', ...)` block):

  ```typescript
  describe('agents sync', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      fakeProc = createFakeProcess();
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readdirSync).mockReturnValue([]);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('copies .md files from container/agents to .claude/agents when source exists', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).endsWith('container/agents');
      });
      vi.mocked(fs.readdirSync).mockImplementation((p) => {
        if (String(p).endsWith('container/agents')) {
          return ['stock-dd-writer.md', 'stock-technical-analyst.md'] as unknown as ReturnType<typeof fs.readdirSync>;
        }
        return [] as unknown as ReturnType<typeof fs.readdirSync>;
      });

      const resultPromise = runContainerAgent(testGroup, testInput, () => {});
      emitOutputMarker(fakeProc, { status: 'success', result: 'done' });
      await vi.advanceTimersByTimeAsync(10);
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);
      await resultPromise;

      expect(vi.mocked(fs.copyFileSync)).toHaveBeenCalledWith(
        expect.stringContaining('stock-dd-writer.md'),
        expect.stringContaining('stock-dd-writer.md'),
      );
      expect(vi.mocked(fs.copyFileSync)).toHaveBeenCalledWith(
        expect.stringContaining('stock-technical-analyst.md'),
        expect.stringContaining('stock-technical-analyst.md'),
      );
    });

    it('removes stale .md files from .claude/agents when absent from source', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).includes('container/agents') || String(p).includes('.claude');
      });
      vi.mocked(fs.readdirSync).mockImplementation((p) => {
        const str = String(p);
        if (str.endsWith('container/agents')) {
          return ['stock-dd-writer.md'] as unknown as ReturnType<typeof fs.readdirSync>;
        }
        if (str.endsWith('agents')) {
          // Destination has a stale file
          return ['stock-dd-writer.md', 'stale-agent.md'] as unknown as ReturnType<typeof fs.readdirSync>;
        }
        return [] as unknown as ReturnType<typeof fs.readdirSync>;
      });

      const resultPromise = runContainerAgent(testGroup, testInput, () => {});
      emitOutputMarker(fakeProc, { status: 'success', result: 'done' });
      await vi.advanceTimersByTimeAsync(10);
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);
      await resultPromise;

      expect(vi.mocked(fs.rmSync)).toHaveBeenCalledWith(
        expect.stringContaining('stale-agent.md'),
      );
    });
  });
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  ```bash
  npm test -- container-runner 2>&1 | tail -30
  ```

  Expected: the two new tests fail with something like `Expected ... to have been called`.

- [ ] **Step 3: Implement agents sync in container-runner.ts**

  In `src/container-runner.ts`, add the following block immediately after the skills sync
  (after the `}` that closes `if (fs.existsSync(skillsSrc)) { ... }` on line ~175),
  and before `mounts.push({ hostPath: groupSessionsDir, containerPath: '/home/node/.claude' ... })`:

  ```typescript
  // Sync agent definitions from container/agents/ into each group's .claude/agents/
  // Syncs individual .md files (not subdirectories) — matches Claude Code's agents/ convention.
  const agentsSrc = path.join(process.cwd(), 'container', 'agents');
  const agentsDst = path.join(groupSessionsDir, 'agents');
  if (fs.existsSync(agentsSrc)) {
    fs.mkdirSync(agentsDst, { recursive: true });
    const srcFiles = new Set(
      fs.readdirSync(agentsSrc).filter((f) => String(f).endsWith('.md')),
    );
    // Remove stale .md agent files no longer in source
    if (fs.existsSync(agentsDst)) {
      for (const existing of fs.readdirSync(agentsDst)) {
        if (String(existing).endsWith('.md') && !srcFiles.has(String(existing))) {
          fs.rmSync(path.join(agentsDst, String(existing)));
        }
      }
    }
    for (const agentFile of srcFiles) {
      fs.copyFileSync(
        path.join(agentsSrc, String(agentFile)),
        path.join(agentsDst, String(agentFile)),
      );
    }
  }
  ```

- [ ] **Step 4: Run tests to confirm they pass**

  ```bash
  npm test -- container-runner 2>&1 | tail -20
  ```

  Expected: all tests in `container-runner` pass.

- [ ] **Step 5: Build**

  ```bash
  npm run build 2>&1 | tail -10
  ```

  Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

  ```bash
  git add src/container-runner.ts src/container-runner.test.ts
  git commit -m "feat(container): sync container/agents/ to .claude/agents/ on each run"
  ```

---

## Task 2: Create reference files

Extract existing content into focused reference documents. No content is invented — it all comes from `SKILL-dd.md`, `SKILL-ta.md`, and `DOCS.md`.

**Files:**
- Create: `container/skills/stock-market-investing/references/screener-schema.md`
- Create: `container/skills/stock-market-investing/references/due-diligence-checklist.md`
- Create: `container/skills/stock-market-investing/references/technical-analysis-checklist.md`
- Create: `container/skills/stock-market-investing/references/recommendation-rules.md`

- [ ] **Step 1: Create the references directory**

  ```bash
  mkdir -p container/skills/stock-market-investing/references
  ```

- [ ] **Step 2: Create screener-schema.md**

  Copy the full content of `container/skills/stock-market-investing/DOCS.md` verbatim into
  `container/skills/stock-market-investing/references/screener-schema.md`.
  (The file already exists and is well-structured — it moves without changes.)

- [ ] **Step 3: Create due-diligence-checklist.md**

  Create `container/skills/stock-market-investing/references/due-diligence-checklist.md` with:

  ````markdown
  # Due Diligence Checklist

  Work through these five lenses in order. For each, state what the data shows
  and whether it is a strength, neutral, or concern.

  ## How to Fetch the Data

  Run `due_diligence.py` to get the structured JSON blob:

  ```bash
  python3 /home/node/.claude/skills/stock-market-investing/due_diligence.py \
    --tickers <TICKER> \
    --db /workspace/group/investments.db
  ```

  The script outputs a JSON array. Parse the first element for the ticker's data.

  ## Data Sections

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

  ## 1. Business Quality & Moat

  - Summarize what the company does in one sentence using the description field.
  - Identify the likely moat type: network effects, switching costs, brand/pricing power, cost advantage, regulatory/scale barriers, or none evident.
  - Use gross_margin as a moat proxy: >50% suggests pricing power, <20% suggests commodity economics.
  - Check roic: sustained >15% across the historical data = durable advantage. <8% = no clear moat.
  - Check if operating_margin is stable or compressing across years — margin erosion signals competitive pressure.

  ## 2. Financial Health

  - **Debt**: compare total_debt to operating_cash_flow. If debt > 4× OCF, flag it.
  - **Current ratio**: >1.5 is healthy, <1.0 is a liquidity concern.
  - **Free cash flow**: must be positive. Compare free_cash_flow to net_income — if FCF is consistently lower, earnings quality is suspect. If FCF exceeds net_income, that's a positive signal.
  - **Altman Z**: <1.8 = distress zone, 1.8–3.0 = grey zone, >3.0 = safe.
  - **Piotroski F**: ≤3 = weak fundamentals, 7–9 = strong.
  - For financial sector stocks, ignore debt ratios — focus on ROE and efficiency.

  ## 3. Valuation

  Always evaluate valuation RELATIVE TO SECTOR, not with absolute thresholds.

  - **Price/FCF**: calculate as market_cap / free_cash_flow. <15 is attractive, 15–25 is fair, >30 is paying a premium. This is the single most important valuation metric — prioritise it.
  - **P/E vs sector context**: state trailing PE and whether it looks high or low for this industry.
  - **PEG ratio**: <1.0 is genuinely cheap for the growth rate, 1.0–1.5 is reasonable, >2.0 is expensive.
  - **EV/EBITDA**: captures debt. Compare to sector norms.
  - **Analyst targets**: calculate upside/downside to mean target. Wide spread = high uncertainty.
  - **Price vs 52-week range**: near the low = potential value, near the high = less margin of safety.

  ## 4. Growth Assessment

  - **Revenue CAGR**: >10% is solid, >20% is strong, negative is a concern.
  - **EPS trajectory**: compare forward_eps to trailing_eps. Growing EPS with stable share count is ideal.
  - **Historical consistency**: look across the annual history. Consistent growth deserves a premium; one-off spikes don't.
  - **Growth vs valuation**: is the growth rate sufficient to justify current multiples?

  ## 5. Risk Assessment

  Identify the top 3 specific risks. Be concrete, not generic. Examples:
  - "Revenue concentration: 38% of revenue comes from a single product line"
  - "Margin compression: operating margin fell from 28% to 21% over 3 years"
  - "Debt maturity wall: $12B in debt with only $3B cash"
  - "Insider selling: 3 executives sold shares in the last quarter"
  - "Short interest at 8% of float suggests meaningful bearish conviction"

  Always end risks with an explicit "I'm wrong if..." condition — the single
  most important thing that would invalidate the bullish or bearish thesis.

  ## Web Context

  After running the five lenses, search the web for recent news on the ticker:
  - Recent earnings results or guidance changes
  - Major product launches, partnerships, or competitive threats
  - Regulatory or legal developments
  - Macroeconomic factors specific to this sector

  Integrate findings into the risk section and bottom line.

  ## Guidelines

  - Never hype. If the numbers are mediocre, say so.
  - When data is null, explicitly note it and lower confidence.
  - Don't invent data. If historical financials aren't available, say so.
  - Sector context matters enormously for valuation.
  - For REITs, note that high debt is structural.
  - This is research to inform the user's decision, not financial advice.
  ````

- [ ] **Step 4: Create technical-analysis-checklist.md**

  Create `container/skills/stock-market-investing/references/technical-analysis-checklist.md` with:

  ````markdown
  # Technical Analysis Checklist

  ## Step 1 — Run the analysis script

  Parse the user's message to extract the horizon (default: `2w`):
  - "next week" → `1w`
  - "next 2 weeks" / "couple of weeks" → `2w`
  - "next month" → `1m`
  - "next quarter" / "3 months" → `3m`

  **Always run this script — do not compute indicators yourself:**

  ```bash
  python3 /home/node/.claude/skills/stock-market-investing/technical_analysis.py \
    --tickers <TICKERS> \
    --db /workspace/group/investments.db \
    --horizon <HORIZON>
  ```

  The script fetches live price data via yfinance and outputs JSON with:
  - `entry_zone` — one of: `entry_now`, `wait`, `avoid`
  - `key_levels` — support, resistance, 50-day MA, 200-day MA
  - `summary` — plain-text entry strategy
  - `indicators` — RSI(14), MACD value, MACD crossover signal

  ## Step 2 — Interpret the output

  Use the script output directly — do not recalculate indicators. Interpret the values:

  **RSI(14):**
  - <30 → oversold (note as bullish setup)
  - 30–70 → neutral
  - >70 → overbought (note as caution)

  **MACD:**
  - Positive and rising → bullish momentum
  - Negative and falling → bearish momentum
  - Recent crossover → signal a potential reversal

  **Entry zone:**
  - `entry_now` — price at or near support, risk/reward favourable
  - `wait` — near resistance or extended, wait for pullback
  - `avoid` — downtrend or no clear setup

  ## Step 3 — Price context

  Calculate `PCT` (percent of 52-week high):
  ```
  PCT = (current_price / 52w_high) * 100
  ```

  - Near the low (PCT < 65%) — potential value entry
  - Near the high (PCT > 90%) — limited margin of safety

  ## Guidelines

  - Report the entry_zone from the script — do not override it with your own judgment unless there is a strong conflicting signal from web news.
  - If the script fails or returns no data, say so explicitly — do not estimate.
  ````

- [ ] **Step 5: Create recommendation-rules.md**

  Create `container/skills/stock-market-investing/references/recommendation-rules.md` with:

  ```markdown
  # Recommendation Rules

  ## Due Diligence Scoring

  Assign a composite score from 0–100:

  | Pillar | Weight | What scores high |
  |---|---|---|
  | Quality | 40% | High ROIC, strong margins, low debt, consistent positive FCF, high Piotroski F |
  | Valuation | 35% | Below-sector PE, PEG <1.5, P/FCF <20, analyst upside >15% |
  | Growth | 25% | Revenue CAGR >10%, growing EPS, positive forward trajectory |

  Score each pillar 0–100 independently, then compute the weighted average.

  ### Verdict thresholds

  | Score | Verdict | save_report label |
  |---|---|---|
  | 75–100 | STRONG BUY | `strong_buy` |
  | 60–74 | BUY | `buy` |
  | 45–59 | HOLD | `hold` |
  | 0–44 | PASS | `pass` |

  ### Confidence level

  | Null fields | Confidence |
  |---|---|
  | ≤2 key fields null | HIGH |
  | 3–5 key fields null | MEDIUM |
  | >5 key fields null | LOW |

  ## Technical Analysis Entry Zones

  The `technical_analysis.py` script outputs an `entry_zone` field. Use it directly
  as the recommendation label in `save_report.py --recommendation`:

  | entry_zone | Meaning |
  |---|---|
  | `entry_now` | Price at or near support; risk/reward favourable |
  | `wait` | Near resistance or extended — wait for pullback |
  | `avoid` | Downtrend or no clear setup |
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add container/skills/stock-market-investing/references/
  git commit -m "feat(stock): add reference files — schema, checklists, recommendation rules"
  ```

---

## Task 3: Create template files

**Files:**
- Create: `container/skills/stock-market-investing/templates/due-diligence-template.md`
- Create: `container/skills/stock-market-investing/templates/technical-template.md`

- [ ] **Step 1: Create the templates directory**

  ```bash
  mkdir -p container/skills/stock-market-investing/templates
  ```

- [ ] **Step 2: Create due-diligence-template.md**

  Create `container/skills/stock-market-investing/templates/due-diligence-template.md` with:

  ````markdown
  # Due Diligence Memo — Output Template

  Format the memo in Telegram markdown:
  - `*bold*` — single asterisks (not double `**`)
  - `_italic_` — underscores
  - `•` — bullet character (not `-`)
  - No `##` headings
  - No bare URLs

  ## Structure

  ```
  📊 *{COMPANY} ({TICKER})* — DD Report

  *Verdict:* {VERDICT} | *Score:* {X}/100 | *Confidence:* {LEVEL}

  🏢 *BUSINESS*
  [What they do. Moat assessment. 2–3 sentences.]

  💰 *FINANCIAL HEALTH*
  [Debt, liquidity, FCF quality. Flag red flags. 2–3 sentences.]

  📉 *VALUATION*
  [Cheap or expensive vs sector? Key multiples. 2–3 sentences.]

  📈 *GROWTH*
  [Revenue & earnings trend. Sustainable? 2–3 sentences.]

  ⚠️ *RISKS*
  • [Risk 1]
  • [Risk 2]
  • [Risk 3]
  • I'm wrong if: [thesis-breaker]

  🎯 *BOTTOM LINE*
  [2 sentences: buy/hold/pass and at what price it becomes interesting if not now.]
  ```

  ## Required output header

  Before the memo, always include these two lines so the coordinator can parse metadata:

  ```
  RECOMMENDATION: <verdict_lowercase>
  TICKERS: <TICKER>

  <memo starts here>
  ```

  The `verdict_lowercase` must be one of: `strong_buy`, `buy`, `hold`, `pass`.
  ````

- [ ] **Step 3: Create technical-template.md**

  Create `container/skills/stock-market-investing/templates/technical-template.md` with:

  ````markdown
  # Technical Analysis Report — Output Template

  Format the report in Telegram markdown:
  - `*bold*` — single asterisks (not double `**`)
  - `_italic_` — underscores
  - `•` — bullet character (not `-`)
  - No `##` headings
  - No bare URLs

  ## Structure

  ```
  *{TICKER} — Technical Entry ({HORIZON} view)*
  *Current: ${PRICE} | 52w: ${LOW}–${HIGH} | At {PCT}% of high*

  *Entry zone: {ENTRY_ZONE}*

  *Key levels*
  • Support: ${SUPPORT}
  • Resistance: ${RESISTANCE}
  • 50-day MA: ${SMA_50} | 200-day MA: ${SMA_200}

  *Technicals*
  • RSI(14): {RSI} ({overbought/neutral/oversold})
  • MACD: {MACD_VALUE} ({crossover signal})

  *Entry strategy*
  [1–2 sentences based on entry_zone and key levels]
  ```

  ## Required output header

  Before the report, always include these two lines so the coordinator can parse metadata:

  ```
  RECOMMENDATION: <entry_zone>
  TICKERS: <TICKER>

  <report starts here>
  ```

  The `entry_zone` must be one of: `entry_now`, `wait`, `avoid`.
  ````

- [ ] **Step 4: Commit**

  ```bash
  git add container/skills/stock-market-investing/templates/
  git commit -m "feat(stock): add DD and TA output templates"
  ```

---

## Task 4: Create stock-market-investing-reference skill

**Files:**
- Create: `container/skills/stock-market-investing-reference/SKILL.md`

- [ ] **Step 1: Create the skill directory and SKILL.md**

  Create `container/skills/stock-market-investing-reference/SKILL.md` with:

  ```markdown
  ---
  name: stock-market-investing-reference
  description: >
    Shared conventions for all stock analysis agents. Preload this for formatting
    rules, recommendation taxonomy, and canonical script/file paths. Not a workflow
    entrypoint — reference only.
  ---

  # Stock Analysis — Shared Reference

  ## Formatting conventions (Telegram markdown)

  - `*bold*` — single asterisks for bold (NOT double `**`)
  - `_italic_` — underscores for italic
  - `•` — bullet character (not `-` or `*`)
  - No `##` headings — use bold labels instead
  - No bare URLs in messages

  ## Recommendation taxonomy

  ### Due Diligence verdicts

  | Label | Score | Meaning |
  |---|---|---|
  | `strong_buy` | 75–100 | High conviction long |
  | `buy` | 60–74 | Positive risk/reward |
  | `hold` | 45–59 | Neutral — wait for better entry or more clarity |
  | `pass` | 0–44 | Avoid at current price |

  ### Technical analysis entry zones

  | Label | Meaning |
  |---|---|
  | `entry_now` | Price at or near support; good risk/reward |
  | `wait` | Approaching resistance or extended; wait for pullback |
  | `avoid` | Downtrend; no clear setup |

  ## Script paths (inside container)

  | Purpose | Path |
  |---|---|
  | Stock screener | `/home/node/.claude/skills/stock-market-investing/stock_screener.py` |
  | Due diligence data | `/home/node/.claude/skills/stock-market-investing/due_diligence.py` |
  | Technical analysis | `/home/node/.claude/skills/stock-market-investing/technical_analysis.py` |
  | Save report | `/home/node/.claude/skills/stock-market-investing/save_report.py` |
  | Query stocks | `/home/node/.claude/skills/stock-market-investing/query_stocks.py` |

  ## Reference file paths

  | Purpose | Path |
  |---|---|
  | DB schema | `/home/node/.claude/skills/stock-market-investing/references/screener-schema.md` |
  | DD checklist | `/home/node/.claude/skills/stock-market-investing/references/due-diligence-checklist.md` |
  | TA checklist | `/home/node/.claude/skills/stock-market-investing/references/technical-analysis-checklist.md` |
  | Recommendation rules | `/home/node/.claude/skills/stock-market-investing/references/recommendation-rules.md` |
  | DD template | `/home/node/.claude/skills/stock-market-investing/templates/due-diligence-template.md` |
  | TA template | `/home/node/.claude/skills/stock-market-investing/templates/technical-template.md` |

  ## Default DB path

  `/workspace/group/investments.db`
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add container/skills/stock-market-investing-reference/
  git commit -m "feat(stock): add stock-market-investing-reference shared conventions skill"
  ```

---

## Task 5: Create DD subagent definition

**Files:**
- Create: `container/agents/stock-dd-writer.md`

- [ ] **Step 1: Create the agents directory and stock-dd-writer.md**

  ```bash
  mkdir -p container/agents
  ```

  Create `container/agents/stock-dd-writer.md` with:

  ````markdown
  ---
  name: stock-dd-writer
  description: >
    Due diligence analyst. Produces a complete investment memo for a given ticker.
    Use when the coordinator needs a DD artifact. Input: ticker symbol and DB path.
  ---

  # Due Diligence Writer

  You are a specialist due diligence analyst. Your only job is to produce a complete
  investment memo for the given ticker. You do not own delivery or persistence —
  return the full artifact and nothing else.

  ## Input

  You will receive a message containing:
  - `Ticker: <TICKER>` — the stock to analyse
  - `DB: <path>` — path to the investments database
  - Optionally: user context (e.g. "I already own this", "thinking of adding")

  ## Step 1 — Fetch data

  ```bash
  python3 /home/node/.claude/skills/stock-market-investing/due_diligence.py \
    --tickers <TICKER> \
    --db <DB_PATH>
  ```

  Parse the first element of the JSON array output.

  ## Step 2 — Analyse

  Follow the checklist in:
  `/home/node/.claude/skills/stock-market-investing/references/due-diligence-checklist.md`

  Apply the scoring rules in:
  `/home/node/.claude/skills/stock-market-investing/references/recommendation-rules.md`

  Search the web for recent news on the ticker (earnings, guidance, regulatory, competitive).

  ## Step 3 — Format

  Use the template in:
  `/home/node/.claude/skills/stock-market-investing/templates/due-diligence-template.md`

  For shared Telegram markdown conventions and path references, consult:
  `/home/node/.claude/skills/stock-market-investing-reference/SKILL.md`

  ## Step 4 — Return

  Your response MUST start with exactly these two header lines, then a blank line,
  then the full memo:

  ```
  RECOMMENDATION: <verdict_lowercase>
  TICKERS: <TICKER>

  <full memo in Telegram markdown>
  ```

  `verdict_lowercase` must be one of: `strong_buy`, `buy`, `hold`, `pass`

  ## Non-goals

  - Do NOT call `mcp__nanoclaw__send_message`
  - Do NOT call `save_report.py`
  - Do NOT return a session summary or a short confirmation
  - Do NOT ask clarifying questions — work with what you have
  - Do NOT return anything other than the structured output above
  ````

- [ ] **Step 2: Commit**

  ```bash
  git add container/agents/stock-dd-writer.md
  git commit -m "feat(stock): add stock-dd-writer agent definition"
  ```

---

## Task 6: Create TA subagent definition

**Files:**
- Create: `container/agents/stock-technical-analyst.md`

- [ ] **Step 1: Create stock-technical-analyst.md**

  Create `container/agents/stock-technical-analyst.md` with:

  ````markdown
  ---
  name: stock-technical-analyst
  description: >
    Technical analysis specialist. Produces a complete entry-point report for a given ticker.
    Use when the coordinator needs a TA artifact. Input: ticker, horizon, DB path.
  ---

  # Technical Analyst

  You are a specialist technical analyst. Your only job is to produce a complete
  technical analysis report for the given ticker. You do not own delivery or
  persistence — return the full artifact and nothing else.

  ## Input

  You will receive a message containing:
  - `Ticker: <TICKER>` — the stock to analyse
  - `Horizon: <HORIZON>` — time horizon: `1w`, `2w`, `1m`, or `3m`
  - `DB: <path>` — path to the investments database

  ## Step 1 — Run the analysis script

  ```bash
  python3 /home/node/.claude/skills/stock-market-investing/technical_analysis.py \
    --tickers <TICKER> \
    --db <DB_PATH> \
    --horizon <HORIZON>
  ```

  Parse the JSON output: `entry_zone`, `key_levels`, `summary`, `indicators`.

  ## Step 2 — Interpret and format

  Follow the checklist in:
  `/home/node/.claude/skills/stock-market-investing/references/technical-analysis-checklist.md`

  Use the template in:
  `/home/node/.claude/skills/stock-market-investing/templates/technical-template.md`

  For shared Telegram markdown conventions and path references, consult:
  `/home/node/.claude/skills/stock-market-investing-reference/SKILL.md`

  ## Step 3 — Return

  Your response MUST start with exactly these two header lines, then a blank line,
  then the full report:

  ```
  RECOMMENDATION: <entry_zone>
  TICKERS: <TICKER>

  <full report in Telegram markdown>
  ```

  `entry_zone` must be one of: `entry_now`, `wait`, `avoid`

  ## Non-goals

  - Do NOT call `mcp__nanoclaw__send_message`
  - Do NOT call `save_report.py`
  - Do NOT return a session summary or a short confirmation
  - Do NOT ask clarifying questions — work with what you have
  - Do NOT return anything other than the structured output above
  ````

- [ ] **Step 2: Commit**

  ```bash
  git add container/agents/stock-technical-analyst.md
  git commit -m "feat(stock): add stock-technical-analyst agent definition"
  ```

---

## Task 7: Rewrite coordinator SKILL.md

Replace only the **Due Diligence** and **Technical Analysis** sections. All other sections
(Stock Screener, Screen Market, Query Stocks, Portfolio Manager) are left unchanged.

**Files:**
- Modify: `container/skills/stock-market-investing/SKILL.md`

- [ ] **Step 1: Replace the Due Diligence section**

  In `container/skills/stock-market-investing/SKILL.md`, find and replace the entire
  `# Due Diligence` section (from `# Due Diligence` through the end of `## Notes`
  before `# Technical Analysis`) with:

  ```markdown
  # Due Diligence

  Coordinate a full investment memo for one or more tickers.

  ## Trigger
  - `DD on AAPL`, `analyze TSLA`, `should I buy MSFT?`, `investment memo for GOOG`, `research X`

  ## How to use

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

  ## Notes
  - Run `/screen-stocks` first if the ticker is not yet in the DB.
  - If a field is null in the data, the subagent will note it and lower confidence.

  ```

- [ ] **Step 2: Replace the Technical Analysis section**

  Find and replace the entire `# Technical Analysis` section (from `# Technical Analysis`
  through the end of that section before `# Portfolio Manager`) with:

  ```markdown
  # Technical Analysis

  Coordinate an entry-point assessment for one or more tickers.

  ## Trigger
  - `technical entry for AAPL`, `is now a good time to buy NVDA?`, `entry point for TSLA in the next 2 weeks`, `chart MSFT`

  ## How to use

  1. **Parse horizon** from the user's message (default: `2w`):
     - "next week" → `1w`
     - "next 2 weeks" / "couple of weeks" → `2w`
     - "next month" → `1m`
     - "next quarter" / "3 months" → `3m`

  2. **Invoke the TA subagent** using the Task tool with agent `stock-technical-analyst`:

     ```
     Ticker: <TICKER>
     Horizon: <HORIZON>
     DB: /workspace/group/investments.db
     ```

  3. **Parse the result.** The subagent output starts with two header lines:

     ```
     RECOMMENDATION: <entry_zone>
     TICKERS: <TICKER>
     ```

     Strip those two lines and the blank line that follows. The remaining text is the full report.

  4. **Save the report:**

     ```bash
     python3 /home/node/.claude/skills/stock-market-investing/save_report.py \
       --db /workspace/group/investments.db \
       --type technical \
       --tickers <TICKER> \
       --recommendation <entry_zone> \
       --content "<full_report>"
     ```

  5. **Send to Telegram:**

     Call `mcp__nanoclaw__send_message` with the full report as the `message` parameter.

  6. **Return** a short confirmation: `Technical analysis complete for <TICKER> — saved as id=N.`

  ```

- [ ] **Step 3: Verify the unchanged sections are intact**

  Read `container/skills/stock-market-investing/SKILL.md` and confirm:
  - `# Stock Screener` section is unchanged (starts at line 1)
  - `# Screen Market` section is unchanged
  - `# Query Stocks` section is unchanged
  - `# Portfolio Manager` section is unchanged
  - `# Due Diligence` and `# Technical Analysis` have the new coordinator content

- [ ] **Step 4: Commit**

  ```bash
  git add container/skills/stock-market-investing/SKILL.md
  git commit -m "feat(stock): rewrite SKILL.md DD and TA sections as coordinator — subagents own artifacts, coordinator owns save/deliver"
  ```

---

## Task 8: Remove retired files

Only after Tasks 5–7 are complete and the new agents are wired in.

**Files:**
- Delete: `container/skills/stock-market-investing/SKILL-dd.md`
- Delete: `container/skills/stock-market-investing/SKILL-ta.md`
- Delete: `container/skills/stock-market-investing/DOCS.md`

- [ ] **Step 1: Delete the retired files**

  ```bash
  git rm container/skills/stock-market-investing/SKILL-dd.md \
         container/skills/stock-market-investing/SKILL-ta.md \
         container/skills/stock-market-investing/DOCS.md
  ```

- [ ] **Step 2: Confirm no remaining references to the old skill names**

  ```bash
  grep -r "stock-dd\b\|stock-technical-analysis\b\|SKILL-dd\|SKILL-ta\|DOCS\.md" \
    container/skills/ container/agents/ --include="*.md" -l
  ```

  Expected: no output (no remaining references).

- [ ] **Step 3: Commit**

  ```bash
  git commit -m "chore(stock): remove retired SKILL-dd.md, SKILL-ta.md, DOCS.md — content migrated to agents/ and references/"
  ```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `container-runner.ts` agents sync | Task 1 |
| `container/agents/stock-dd-writer.md` | Task 5 |
| `container/agents/stock-technical-analyst.md` | Task 6 |
| `references/screener-schema.md` | Task 2 |
| `references/due-diligence-checklist.md` | Task 2 |
| `references/technical-analysis-checklist.md` | Task 2 |
| `references/recommendation-rules.md` | Task 2 |
| `templates/due-diligence-template.md` | Task 3 |
| `templates/technical-template.md` | Task 3 |
| `stock-market-investing-reference/SKILL.md` | Task 4 |
| Coordinator SKILL.md rewrite | Task 7 |
| Retire SKILL-dd.md / SKILL-ta.md / DOCS.md | Task 8 |
| Screener/query/portfolio sections unchanged | Task 7 Step 3 |
| Python scripts unchanged | Not touched in any task |
| index.ts delivery path preserved | Not touched |

All spec requirements covered.
