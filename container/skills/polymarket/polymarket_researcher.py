# polymarket_researcher.py
# Optimized: Haiku for filtering, Sonnet for reasoning, caching, batching, slim prompts
# v2: evaluates both sides of every market, filters by EV instead of probability floor

import requests
import json
import sqlite3
import os
from datetime import datetime, timezone, timedelta
from anthropic import Anthropic

# ─────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────
MIN_EV              = 0.05     # Minimum expected value to report (5%)
MAX_VOLUME          = 5000
MAX_AGE_HOURS       = 48
TOP_N               = 10
CACHE_DB            = "/workspace/group/polymarket_cache.db"
CACHE_TTL_HOURS     = 6        # Re-evaluate only if odds shifted or cache expired
ODDS_SHIFT_TRIGGER  = 0.05     # Re-evaluate if reference odds moved more than 5%
BATCH_SIZE          = 5        # Markets per Sonnet call
HAIKU_BATCH_SIZE    = 20       # Markets per Haiku call
SCAN_LIMIT          = 300      # How many markets to pull from API

# Credentials are injected by the NanoClaw credential proxy via environment variables.
# ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY are set automatically in the container.
client = Anthropic()

# ─────────────────────────────────────────
# CACHE (SQLite)
# Uses the first outcome (YES) probability as reference for drift detection.
# ─────────────────────────────────────────
def init_cache():
    conn = sqlite3.connect(CACHE_DB)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS evaluations (
            market_id TEXT PRIMARY KEY,
            question TEXT,
            reference_prob REAL,
            recommended_outcome TEXT,
            market_probability REAL,
            ai_win_probability REAL,
            recommended_side TEXT,
            reasoning TEXT,
            confidence TEXT,
            expected_value REAL,
            evaluated_at TEXT
        )
    """)
    conn.commit()
    return conn

def get_cached(conn, market_id, reference_prob):
    row = conn.execute(
        "SELECT * FROM evaluations WHERE market_id = ?", (market_id,)
    ).fetchone()
    if not row:
        return None
    evaluated_at = datetime.fromisoformat(row[10])
    age = datetime.now(timezone.utc) - evaluated_at.replace(tzinfo=timezone.utc)
    odds_shifted = abs(row[2] - reference_prob) > ODDS_SHIFT_TRIGGER
    if age.total_seconds() > CACHE_TTL_HOURS * 3600 or odds_shifted:
        return None
    return {
        "market_id":          row[0],
        "question":           row[1],
        "reference_prob":     row[2],
        "recommended_outcome": row[3],
        "market_probability": row[4],
        "ai_win_probability": row[5],
        "recommended_side":   row[6],
        "reasoning":          row[7],
        "confidence":         row[8],
        "expected_value":     row[9],
        "from_cache":         True,
    }

def save_cache(conn, results):
    for r in results:
        conn.execute("""
            INSERT OR REPLACE INTO evaluations VALUES (?,?,?,?,?,?,?,?,?,?,?)
        """, (
            r["id"], r["question"], r["reference_prob"],
            r["recommended_outcome"], r["market_probability"],
            r["ai_win_probability"], r["recommended_side"],
            r["reasoning"], r["confidence"], r["expected_value"],
            datetime.now(timezone.utc).isoformat()
        ))
    conn.commit()

# ─────────────────────────────────────────
# MODULE 1 — MARKET SCANNER (no LLM cost)
# ─────────────────────────────────────────
def fetch_markets():
    url = "https://gamma-api.polymarket.com/markets"
    params = {"limit": SCAN_LIMIT, "active": "true", "closed": "false"}
    return requests.get(url, params=params).json()

def filter_candidates(markets):
    """Keep recently-created or low-volume markets. Collect ALL outcomes per market."""
    candidates = []
    cutoff = datetime.now(timezone.utc) - timedelta(hours=MAX_AGE_HOURS)

    for m in markets:
        try:
            volume   = float(m.get("volume", 0) or 0)
            created  = m.get("createdAt", "")
            outcomes = m.get("outcomes", "[]")
            prices   = m.get("outcomePrices", "[]")

            if isinstance(outcomes, str): outcomes = json.loads(outcomes)
            if isinstance(prices, str):   prices   = json.loads(prices)
            if not outcomes or not prices: continue

            is_recent     = False
            is_low_volume = volume < MAX_VOLUME

            if created:
                dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
                is_recent = dt >= cutoff

            if not (is_recent or is_low_volume):
                continue

            # Collect all valid outcomes with their prices
            outcome_prices = [
                (o, float(p))
                for o, p in zip(outcomes, prices)
                if float(p) > 0.01  # ignore dust
            ]
            if not outcome_prices:
                continue

            # Reference prob = first outcome (usually YES) for cache drift detection
            reference_prob = outcome_prices[0][1]

            # Days to close (for annualised EV display)
            end_date = m.get("endDateIso") or m.get("endDate") or ""
            days_to_close = None
            if end_date:
                try:
                    end_dt = datetime.fromisoformat(end_date.replace("Z", "+00:00"))
                    delta = end_dt - datetime.now(timezone.utc)
                    days_to_close = max(delta.days + delta.seconds / 86400, 0.1)
                except:
                    pass

            candidates.append({
                "id":             m.get("id"),
                "question":       m.get("question", ""),
                "description":    (m.get("description", "") or "")[:300],
                "volume":         volume,
                "created_at":     created,
                "outcome_prices": outcome_prices,  # [(outcome, prob), ...]
                "reference_prob": reference_prob,
                "days_to_close":  days_to_close,
            })
        except:
            continue

    return candidates

# ─────────────────────────────────────────
# MODULE 2 — AI RESEARCHER
# Haiku pre-screens (batched), Sonnet evaluates both sides
# ─────────────────────────────────────────
def haiku_prescreen(candidates):
    """Quick pass with Haiku to drop obvious junk. Batched at HAIKU_BATCH_SIZE."""
    if not candidates:
        return []

    kept = []
    for start in range(0, len(candidates), HAIKU_BATCH_SIZE):
        batch = candidates[start:start + HAIKU_BATCH_SIZE]
        batch_text = "\n\n".join([
            f"{i+1}. {c['question']} ({' / '.join(f'{o} {round(p*100)}%' for o, p in c['outcome_prices'])})"
            for i, c in enumerate(batch)
        ])

        prompt = f"""You are filtering prediction market questions.
For each question below, reply KEEP or DROP.
DROP if: purely joke/meme, technically unresolvable, or obviously misframed.
KEEP if: real-world verifiable event with clear resolution criteria.

{batch_text}

Reply as JSON: {{"decisions": ["KEEP","DROP",...]}}"""

        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}]
        )
        decisions = json.loads(response.content[0].text).get("decisions", [])
        kept.extend(c for c, d in zip(batch, decisions) if d == "KEEP")

    return kept

def sonnet_evaluate_batch(batch):
    """Evaluate a batch of markets. Sonnet picks the best side to bet, or NONE."""
    batch_text = "\n\n".join([
        f"[{i+1}] {c['question']}\n"
        f"Odds: {' / '.join(f\"{o} {round(p*100,1)}%\" for o, p in c['outcome_prices'])}\n"
        f"Context: {c['description']}"
        for i, c in enumerate(batch)
    ])

    prompt = f"""You are an expert prediction market analyst.
Evaluate these {len(batch)} markets. For each, assess whether either side offers an edge over the market odds.

{batch_text}

For each market, pick the single BEST side to bet based on your knowledge, or NONE if you see no edge.
Give your independent probability estimate for the chosen outcome.

JSON format:
{{"evaluations": [
  {{
    "recommended_outcome": "exact outcome label from above, or NONE",
    "ai_win_probability": 0.XX,
    "confidence": "low/medium/high",
    "reasoning": "one sentence"
  }},
  ...
]}}"""

    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}]
    )
    return json.loads(response.content[0].text).get("evaluations", [])

def ai_research(candidates, conn):
    """Orchestrates caching + Haiku prescreening + Sonnet batched evaluation."""
    results     = []
    to_evaluate = []

    # Check cache first
    for c in candidates:
        cached = get_cached(conn, c["id"], c["reference_prob"])
        if cached:
            cached.update({k: v for k, v in c.items() if k not in cached})
            results.append(cached)
        else:
            to_evaluate.append(c)

    print(f"  {len(results)} from cache, {len(to_evaluate)} need evaluation")

    if not to_evaluate:
        return results

    # Haiku pre-screening (batched)
    print(f"  Haiku prescreening {len(to_evaluate)} candidates...")
    to_evaluate = haiku_prescreen(to_evaluate)
    print(f"  {len(to_evaluate)} passed prescreening")

    # Sonnet batched evaluation
    evaluated = []
    for i in range(0, len(to_evaluate), BATCH_SIZE):
        batch = to_evaluate[i:i + BATCH_SIZE]
        print(f"  Sonnet evaluating batch {i // BATCH_SIZE + 1} ({len(batch)} markets)...")
        evals = sonnet_evaluate_batch(batch)
        for c, e in zip(batch, evals):
            recommended_outcome = e.get("recommended_outcome", "NONE")
            if recommended_outcome == "NONE":
                continue  # Sonnet found no edge — skip

            # Find the market probability for the recommended outcome
            market_prob = next(
                (p for o, p in c["outcome_prices"] if o == recommended_outcome),
                None
            )
            if market_prob is None or market_prob <= 0:
                continue

            ai_prob  = e.get("ai_win_probability", 0)
            roi      = round((1 / market_prob) - 1, 4)
            ev       = round(ai_prob * roi, 4)

            evaluated.append({
                **c,
                "recommended_outcome": recommended_outcome,
                "market_probability":  market_prob,
                "market_roi":          roi,
                "ai_win_probability":  ai_prob,
                "recommended_side":    recommended_outcome,
                "reasoning":           e.get("reasoning"),
                "confidence":          e.get("confidence"),
                "expected_value":      ev,
                "from_cache":          False,
            })

    save_cache(conn, evaluated)
    results.extend(evaluated)
    return results

# ─────────────────────────────────────────
# MODULE 3 — EV FILTER + REPORT
# ─────────────────────────────────────────
def score_and_report(results):
    # Filter by minimum EV, then rank
    qualified = [r for r in results if r.get("expected_value", 0) >= MIN_EV]
    ranked    = sorted(qualified, key=lambda x: x["expected_value"], reverse=True)

    print("\n" + "="*60)
    print("POLYMARKET RESEARCHER — TOP OPPORTUNITIES")
    print(f"Run at: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"Min EV threshold: {round(MIN_EV*100)}%  |  Qualified: {len(qualified)}")
    print("="*60)

    if not ranked:
        print("\nNo opportunities above the EV threshold found in this scan.")
        return ranked

    for i, r in enumerate(ranked[:TOP_N], 1):
        cache_tag = " [cached]" if r.get("from_cache") else ""
        market_odds_str = " / ".join(
            f"{o} {round(p*100,1)}%" for o, p in r.get("outcome_prices", [])
        )
        print(f"\n#{i}{cache_tag} {r['question']}")
        print(f"  Bet:          {r['recommended_outcome']}")
        print(f"  Market odds:  {market_odds_str}")
        print(f"  AI estimate:  {round(r['ai_win_probability']*100,1)}% for {r['recommended_outcome']}")
        print(f"  ROI if win:   {round(r['market_roi']*100,1)}%")
        ev = r['expected_value']
        days = r.get("days_to_close")
        if days and days > 0:
            annualised = round(((1 + ev) ** (365 / days) - 1) * 100, 1)
            ev_str = f"{round(ev*100,1)}%  (annualised: {annualised}%)"
            resolves_str = f"{round(days)} day{'s' if round(days) != 1 else ''}"
        else:
            ev_str = f"{round(ev*100,1)}%"
            resolves_str = "unknown"
        print(f"  Expected EV:  {ev_str}")
        print(f"  Resolves in:  {resolves_str}")
        print(f"  Confidence:   {r['confidence']}")
        print(f"  Reasoning:    {r['reasoning']}")
        print(f"  Volume:       ${r['volume']:,.0f}")

    return ranked

# ─────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────
if __name__ == "__main__":
    conn = init_cache()

    print("Fetching markets...")
    markets    = fetch_markets()
    print(f"Fetched {len(markets)} markets")

    print("Filtering candidates...")
    candidates = filter_candidates(markets)
    print(f"{len(candidates)} candidates after local filter")

    print("Running AI research...")
    results    = ai_research(candidates, conn)

    score_and_report(results)
    conn.close()
