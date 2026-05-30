# Stock Screen Guided Module

Host-owned deterministic `/screen-market` guided wizard. Exact no-argument `/screen-market` is consumed by the host when `SCREEN_MARKET_GUIDED_HOST=true`; argument-bearing and natural-language requests remain agent-owned.

Wizard questions use `pending_host_questions` for render metadata so Chat SDK action handlers can resolve option indexes without inserting `pending_questions` rows that would route responses back into the agent.

## Operational Switch

Set `SCREEN_MARKET_GUIDED_HOST=true` and restart the host to enable the code-driven wizard. With the flag unset or `false`, exact `/screen-market` follows the existing agent-guided behavior and the router keeps the immediate `Opening screen-market options...` acknowledgement path.

The interceptor is intentionally exact-match only: `/screen-market France 30`, `/screen-market nasdaq nyse`, and natural-language requests such as `Collect all common stocks data for the United States, small caps and above` continue to reach the agent.
