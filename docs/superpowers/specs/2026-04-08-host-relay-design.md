# Generic Host Relay — Design Spec

**Date:** 2026-04-08  
**Status:** Approved

## Problem

Container agents run on datacenter IPs that are blocked by bot-detection layers on sites like Yahoo Finance (`fc.yahoo.com`). The host machine has a residential IP and can reach these endpoints. `curl_cffi` with Chrome TLS impersonation works from the host but breaks when tunneled through an HTTP CONNECT proxy due to HTTP/2 incompatibility.

## Solution

A minimal relay service (`host_relay.py`) runs on the host and proxies arbitrary HTTPS GET requests via a persistent `curl_cffi` Chrome-impersonating session. Containers reach it via `host.docker.internal`.

## Architecture

```
Container (Python script)
  │  requests.get(HOST_RELAY_URL + "/fetch?url=...&param=val")
  ▼
host_relay.py  (host network, port 8765, binds 0.0.0.0)
  │  curl_cffi Session(impersonate="chrome124")
  │  session.get(url, params={forwarded params})
  ▼
Target site (finance.yahoo.com, any blocked HTTPS endpoint)
```

- Single persistent `curl_cffi` session — accumulates cookies across requests (required for Yahoo Finance crumb flow and general session-based sites)
- No domain-specific logic in the relay
- `ThreadingHTTPServer` for concurrent requests

## Relay API

**Endpoint:** `GET /fetch`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `url` | yes | Full target URL, URL-encoded |
| `*` | no | All other params forwarded as-is to the target |

**Response:** verbatim passthrough — same status code, same body, `Content-Type` preserved.

**Errors:**

| Condition | Status | Body |
|-----------|--------|------|
| Missing `url` param | 400 | `missing url parameter` |
| Unknown path | 404 | `not found` |
| curl_cffi network error | 502 | `relay fetch error: <exception>` |
| Non-2xx from target | same as target | target body unchanged |

No retries in the relay. Callers handle retry logic as needed.

**Example:**
```
GET /fetch?url=https%3A%2F%2Ffinance.yahoo.com%2Fv10%2Ffinance%2FquoteSummary%2FAAPL&modules=summaryDetail
```

## Client-Side Changes

**`stock_screener.py` and `due_diligence.py`:**
- Rename `_YAHOO_RELAY_URL` → `_HOST_RELAY_URL = os.environ.get("HOST_RELAY_URL") or None`
- When relay is set, call `requests.get(f"{_HOST_RELAY_URL}/fetch", params={"url": target_url, **extra_params})`
- When relay is unset, fall back to direct `curl_cffi` session (existing path)

**`SKILL.md`, `stock-dd-writer.md`, `due-diligence-checklist.md`:**
- Replace `YAHOO_RELAY_URL=http://host.docker.internal:8765 \` with `HOST_RELAY_URL=http://host.docker.internal:8765 \`

**`data/sessions/telegram_main/.claude/settings.json`:**
- Rename `YAHOO_RELAY_URL` → `HOST_RELAY_URL` in `env` block

## Files Changed

| Before | After | Action |
|--------|-------|--------|
| `scripts/yahoo_relay.py` | `scripts/host_relay.py` | Replace with generic relay |
| `scripts/yahoo_proxy.py` | — | Delete |
| `scripts/test_yahoo_relay.py` | `scripts/test_host_relay.py` | Replace with generic tests |
| `scripts/nanoclaw-yahoo-relay.service` | `scripts/nanoclaw-host-relay.service` | Rename, update ExecStart |
| `YAHOO_RELAY_URL` (all occurrences) | `HOST_RELAY_URL` | Rename throughout |

## Error Handling

- Relay errors surface as HTTP status codes — `resp.raise_for_status()` in callers handles them identically to direct Yahoo errors
- Port conflict at startup → fail fast with clear error message
- No silent fallbacks or swallowed exceptions

## Testing

**`scripts/test_host_relay.py`** (unit, mocks `curl_cffi.requests.Session.get`):
- `GET /fetch?url=...` → returns mocked body + status
- Extra params forwarded to mock
- Missing `url` → 400
- Unknown path → 404
- curl_cffi exception → 502

**`test_stock_screener.py`** (`TestFetchQuoteSummaryRelay`):
- `HOST_RELAY_URL` set → `requests.get` called with `/fetch?url=...&modules=...`
- `HOST_RELAY_URL` unset → direct path (existing test, unchanged)
- Non-2xx from relay → `raise_for_status()` propagates

**`test_due_diligence.py`** (`TestFetchDDQuoteSummaryRelay`): same pattern.

## Housekeeping

- `CHANGELOG.md`: move Yahoo Finance relay entry to generic host relay
- `CLAUDE.md` Key Files table: rename relay entry
- `docs/DEBUG_CHECKLIST.md`: rename relay troubleshooting section

## Installation

```bash
# Copy and enable systemd user service
cp scripts/nanoclaw-host-relay.service ~/.config/systemd/user/
systemctl --user enable --now nanoclaw-host-relay
```

The relay binds `0.0.0.0:8765` so it is reachable from Docker containers via `host.docker.internal:8765`.
