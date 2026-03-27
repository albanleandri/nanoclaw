# polymarket_researcher.py
# Optimized: Haiku for filtering, Sonnet for reasoning, caching, batching, slim prompts

import requests
import json
import sqlite3
import os
from datetime import datetime, timezone, timedelta
from anthropic import Anthropic

# ─────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────
MIN_PROBABILITY     = 0.70
MAX_VOLUME          = 5000
MAX_AGE_HOURS       = 48
TOP_N               = 10
CACHE_DB            = "/workspace/group/polymarket_cache.db"
CACHE_TTL_HOURS     = 6        # Re-evaluate only if odds shifted or cache expired
ODDS_SHIFT_TRIGGER  = 0.05     # Re-evaluate if odds moved more than 5%
BATCH_SIZE          = 5        # Markets per LLM call
SCAN_LIMIT          = 300      # How many markets to pull from API

# Credentials are injected by the NanoClaw credential proxy via environment variables.
# ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY are set automatically in the container.
client = Anthropic()

# ─────────────────────────────────────────
# CACHE (SQLite)
# ─────────────────────────────────────────
def init_cache():
    conn = sqlite3.connect(CACHE_DB)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS evaluations (
            market_id TEXT PRIMARY KEY,
            question TEXT,
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

def get_cached(conn, market_id, current_prob):
    row = conn.execute(
        "SELECT * FROM evaluations WHERE market_id = ?", (market_id,)
    ).fetchone()
    if not row:
        return None
    evaluated_at = datetime.fromisoformat(row[8])
    age = datetime.now(timezone.utc) - evaluated_at.replace(tzinfo=timezone.utc)
    odds_shifted = abs(row[2] - current_prob) > ODDS_SHIFT_TRIGGER
    if age.total_seconds() > CACHE_TTL_HOURS * 3600 or odds_shifted:
        return None  # Stale or odds moved — re-evaluate
    return {
        "market_id": row[0], "question": row[1],
        "market_probability": row[2], "ai_win_probability": row[3],
        "recommended_side": row[4], "reasoning": row[5],
        "confidence": row[6], "expected_value": row[7],
        "from_cache": True
    }

def save_cache(conn, results):
    for r in results:
        conn.execute("""
            INSERT OR REPLACE INTO evaluations VALUES (?,?,?,?,?,?,?,?,?)
        """, (
            r["id"], r["question"], r["market_probability"],
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

            for i, price in enumerate(prices):
                prob = float(price)
                if prob >= MIN_PROBABILITY:
                    candidates.append({
                        "id":                   m.get("id"),
                        "question":             m.get("question", ""),
                        "description":          (m.get("description", "") or "")[:300],
                        "volume":               volume,
                        "created_at":           created,
                        "recommended_outcome":  outcomes[i],
                        "market_probability":   prob,
                        "market_roi":           round((1 / prob) - 1, 4),
                    })
                    break
        except:
            continue

    return candidates

# ─────────────────────────────────────────
# MODULE 2 — AI RESEARCHER
# Haiku pre-screens, Sonnet deeply evaluates
# Batched: 5 markets per call
# ─────────────────────────────────────────
def haiku_prescreen(candidates):
    """Quick pass with Haiku to drop obvious junk before Sonnet."""
    if not candidates:
        return []

    batch_text = "\n\n".join([
        f"{i+1}. {c['question']} ({round(c['market_probability']*100)}% {c['recommended_outcome']})"
        for i, c in enumerate(candidates)
    ])

    prompt = f"""You are filtering prediction market bets.
For each bet below, reply KEEP or DROP.
DROP if: purely joke/meme, technically unresolvable, or obviously misframed.
KEEP if: real-world verifiable event with clear resolution criteria.

{batch_text}

Reply as JSON: {{"decisions": ["KEEP","DROP",...]}}"""

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=256,
        messages=[{"role": "user", "content": prompt}]
    )
    decisions = json.loads(response.content[0].text).get("decisions", [])
    return [c for c, d in zip(candidates, decisions) if d == "KEEP"]

def sonnet_evaluate_batch(batch):
    """Deep evaluation of a batch of markets with Sonnet."""
    batch_text = "\n\n".join([
        f"[{i+1}] {c['question']}\nOdds: {round(c['market_probability']*100,1)}% on '{c['recommended_outcome']}'\nContext: {c['description']}"
        for i, c in enumerate(batch)
    ])

    prompt = f"""You are an expert prediction market analyst.
Evaluate these {len(batch)} bets. For each, use your knowledge to assess true probability.

{batch_text}

For each bet respond with your independent probability estimate, NOT the market's.
JSON format:
{{"evaluations": [
  {{"ai_win_probability": 0.XX, "recommended_side": "YES or NO", "confidence": "low/medium/high", "reasoning": "one sentence"}},
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
    results       = []
    to_evaluate   = []

    # Check cache first
    for c in candidates:
        cached = get_cached(conn, c["id"], c["market_probability"])
        if cached:
            cached.update(c)
            results.append(cached)
        else:
            to_evaluate.append(c)

    print(f"  {len(results)} from cache, {len(to_evaluate)} need evaluation")

    if not to_evaluate:
        return results

    # Haiku pre-screening
    print(f"  Haiku prescreening {len(to_evaluate)} candidates...")
    to_evaluate = haiku_prescreen(to_evaluate)
    print(f"  {len(to_evaluate)} passed prescreening")

    # Sonnet batched evaluation
    evaluated = []
    for i in range(0, len(to_evaluate), BATCH_SIZE):
        batch = to_evaluate[i:i+BATCH_SIZE]
        print(f"  Sonnet evaluating batch {i//BATCH_SIZE + 1} ({len(batch)} markets)...")
        evals = sonnet_evaluate_batch(batch)
        for c, e in zip(batch, evals):
            ai_prob = e.get("ai_win_probability", 0)
            ev      = round(ai_prob * c["market_roi"], 4)
            evaluated.append({
                **c,
                "ai_win_probability": ai_prob,
                "recommended_side":   e.get("recommended_side"),
                "reasoning":          e.get("reasoning"),
                "confidence":         e.get("confidence"),
                "expected_value":     ev,
                "from_cache":         False
            })

    save_cache(conn, evaluated)
    results.extend(evaluated)
    return results

# ─────────────────────────────────────────
# MODULE 3 — EV SCORER + REPORT
# ─────────────────────────────────────────
def score_and_report(results):
    ranked = sorted(results, key=lambda x: x.get("expected_value", 0), reverse=True)

    print("\n" + "="*60)
    print("POLYMARKET RESEARCHER — TOP OPPORTUNITIES")
    print(f"Run at: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("="*60)

    for i, r in enumerate(ranked[:TOP_N], 1):
        cache_tag = " [cached]" if r.get("from_cache") else ""
        print(f"\n#{i}{cache_tag} {r['question']}")
        print(f"  Bet:          {r['recommended_side']} on '{r['recommended_outcome']}'")
        print(f"  Market odds:  {round(r['market_probability']*100,1)}%")
        print(f"  AI estimate:  {round(r['ai_win_probability']*100,1)}%")
        print(f"  ROI if win:   {round(r['market_roi']*100,1)}%")
        print(f"  Expected EV:  {round(r['expected_value']*100,1)}%")
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
