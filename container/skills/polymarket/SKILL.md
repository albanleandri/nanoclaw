# Polymarket Researcher

Scans Polymarket for mispriced prediction market bets with high Expected Value.
Targets new or low-volume markets before crowd wisdom corrects the odds.

## Trigger phrases
- "scan polymarket"
- "find polymarket bets"
- "polymarket opportunities"
- "research polymarket"

## How to use

When triggered, run:

```bash
python3 /home/node/.claude/skills/polymarket/polymarket_researcher.py
```

Then summarise the top opportunities from the output in this format for each:
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
