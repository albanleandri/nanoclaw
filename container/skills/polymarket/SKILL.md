# Polymarket Researcher

Scans Polymarket for mispriced prediction market bets with high Expected Value.
Targets new or low-volume markets before crowd wisdom corrects the odds.

## Trigger phrases
- "scan polymarket"
- "find polymarket bets"
- "polymarket opportunities"
- "research polymarket"

## How to use

When triggered, follow these steps in order:

**Step 1 — Acknowledge immediately**
Use send_message to confirm the scan has started:
> "Scanning Polymarket for opportunities... fetching markets and filtering candidates. I'll send results when done (usually 1–2 min)."

**Step 2 — Run the script**
```bash
python3 /home/node/.claude/skills/polymarket/polymarket_researcher.py
```

**Step 3 — Send a mid-progress update (optional)**
If the script prints that many candidates need evaluation (e.g. >10), use send_message:
> "Found X candidates — running AI evaluation now..."

**Step 4 — Report results**
Summarise the top opportunities from the script output in this format for each:
- **Question** — what the market is about
- **Bet** — which side (YES/NO) and on what outcome
- **Market odds vs AI estimate** — e.g. "Market: 73% / AI: 61%"
- **Expected Value** — as a percentage
- **Confidence** — low / medium / high
- **Reasoning** — one line

## Notes
- Results are cached in `/workspace/group/polymarket_cache.db` for 6 hours
- Haiku pre-screens candidates, Sonnet does deep evaluation
- Re-evaluates automatically if odds shift more than 5%
- First run may take 1–2 minutes depending on how many markets need evaluation
