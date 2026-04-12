# Operations

Canonical operational commands for both Codex and Claude Code live here. Prefer these wrappers over repeating raw shell snippets in docs or scoped instructions.

## Build

```bash
npm run build
npm run container:build
```

## Setup

```bash
npm run setup:bootstrap
npm run setup:step -- environment
npm run setup:step -- timezone -- --tz <your-timezone>
```

## Service

```bash
npm run service:status
npm run service:restart
```

`service:restart` chooses the best available path in this order:
- `systemctl --user restart nanoclaw`
- `launchctl kickstart -k gui/<uid>/com.nanoclaw`
- `bash start-nanoclaw.sh`

`service:status` checks the best available path in this order:
- `systemctl --user status nanoclaw`
- `launchctl list | grep nanoclaw`
- `ps` lookup of the `start-nanoclaw.sh` fallback process

## Runtime Guardrails

- Keep the Telegram runtime on the Anthropic Agent SDK.
- Do not migrate orchestration to OpenAI Agents SDK, LangGraph, or another framework unless explicitly requested.
- Do not replace the current Telegram agent architecture during routine collaboration cleanup.

## Usage-Limit Replies

- If the provider returns a usage-limit or rate-limit error before the agent sends any reply, NanoClaw now sends a short user-facing message instead of failing silently.
- When the upstream error exposes a reset or retry time, the reply includes that time in the configured `TZ` timezone.
- While the temporary cooldown is active, later messages in that chat are silently consumed so they do not queue up behind the limit window.
