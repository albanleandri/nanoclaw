---
name: init-onecli
description: Install and initialize OneCLI Agent Vault. Migrates existing .env credentials to the vault. Use after /update-nanoclaw brings in OneCLI as a breaking change, or for first-time OneCLI setup.
---

# Initialize OneCLI Agent Vault

This skill installs OneCLI, configures the Agent Vault gateway, and migrates any existing `.env` credentials into it. Run this after `/update-nanoclaw` introduces OneCLI as a breaking change, or any time OneCLI needs to be set up from scratch.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. pasting a token).

## Phase 1: Pre-flight

### Check if OneCLI is already working

```bash
onecli version 2>/dev/null
```

If the command succeeds, OneCLI is installed, check for an Anthropic secret:

```bash
onecli secrets list
```

If an Anthropic secret exists, tell the user OneCLI is already configured and working. Use AskUserQuestion:

1. **Keep current setup** — description: "OneCLI is installed and has credentials configured. Nothing to do."
2. **Reconfigure** — description: "Start fresh — reinstall OneCLI and re-register credentials."

If they choose to keep, skip to Phase 5 (Verify). If they choose to reconfigure, continue.

### Check for native credential proxy

```bash
grep "credential-proxy" src/index.ts 2>/dev/null
```

If `startCredentialProxy` is imported, the native credential proxy skill is active. Tell the user: "You're currently using the native credential proxy (`.env`-based). This skill will switch you to OneCLI's Agent Vault, which adds per-agent policies and rate limits. Your `.env` credentials will be migrated to the vault."

Use AskUserQuestion:
1. **Continue** — description: "Switch to OneCLI Agent Vault."
2. **Cancel** — description: "Keep the native credential proxy."

If they cancel, stop.

### Check the codebase expects OneCLI

```bash
grep "@onecli-sh/sdk" package.json
```

If `@onecli-sh/sdk` is NOT in package.json, the codebase hasn't been updated to use OneCLI yet. Tell the user to run `/update-nanoclaw` first to get the OneCLI integration, then retry `/init-onecli`. Stop here.

## Phase 2: Install OneCLI

### Install the gateway and CLI

```bash
curl -fsSL onecli.sh/install | sh
curl -fsSL onecli.sh/cli/install | sh
```

Verify: `onecli version`

If the command is not found, the CLI was likely installed to `~/.local/bin/`. Add it to PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
grep -q '.local/bin' ~/.bashrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
grep -q '.local/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Re-verify with `onecli version`.

### Configure the CLI

Point the CLI at the local OneCLI instance, the ONECLI_URL was output from the install script above:

```bash
onecli config set api-host ${ONECLI_URL}
```

### Set ONECLI_URL in .env

```bash
grep -q 'ONECLI_URL' .env 2>/dev/null || echo 'ONECLI_URL=${ONECLI_URL}' >> .env
```

### Wait for gateway readiness

The gateway may take a moment to start after installation. Poll for up to 15 seconds:

```bash
for i in $(seq 1 15); do
  curl -sf ${ONECLI_URL}/health && break
  sleep 1
done
```

If it never becomes healthy, check if the gateway process is running:

```bash
ps aux | grep -i onecli | grep -v grep
```

If it's not running, try starting it manually: `onecli start`. If that fails, show the error and stop — the user needs to debug their OneCLI installation.

## Phase 3: Migrate existing credentials

### Scan .env for credentials to migrate

Read the `.env` file and look for these credential variables:

| .env variable | OneCLI secret type | Host pattern |
|---|---|---|
| `ANTHROPIC_API_KEY` | `anthropic` | `api.anthropic.com` |
| `CLAUDE_CODE_OAUTH_TOKEN` | `anthropic` | `api.anthropic.com` |
| `ANTHROPIC_AUTH_TOKEN` | `anthropic` | `api.anthropic.com` |

Read `.env`:

```bash
cat .env
```

Parse the file for any of the credential variables listed above.

### If credentials found in .env

For each credential found, migrate it to OneCLI:

**Anthropic API key** (`ANTHROPIC_API_KEY=sk-ant-...`):
```bash
onecli secrets create --name Anthropic --type anthropic --value <key> --host-pattern api.anthropic.com
```
Set `ANTHROPIC_AUTH_MODE=api-key` in `.env` so NanoClaw knows to boot the Anthropic SDK in API-key mode after the raw key is removed.

**Claude OAuth token** (`CLAUDE_CODE_OAUTH_TOKEN=...` or `ANTHROPIC_AUTH_TOKEN=...`):
```bash
onecli secrets create --name Anthropic --type anthropic --value <token> --host-pattern api.anthropic.com
```
Set `ANTHROPIC_AUTH_MODE=oauth` in `.env` so NanoClaw knows to boot the Anthropic SDK in OAuth mode after the raw token is removed.

After successful migration, remove the raw credential lines from `.env`. Use the Edit tool to remove only `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and `ANTHROPIC_AUTH_TOKEN`. Keep `ONECLI_URL`, `ANTHROPIC_AUTH_MODE`, channel tokens, and other non-Anthropic settings intact.

Verify the secret was registered:
```bash
onecli secrets list
```

Tell the user: "Migrated your Anthropic credentials from `.env` to the OneCLI Agent Vault. The raw keys have been removed from `.env` — they're now managed by OneCLI and will be injected at request time without entering containers."

### Scope note for other credentials

Do **not** automatically migrate arbitrary container env vars like `OPENAI_API_KEY` or `PARALLEL_API_KEY` as part of this skill. Many SDKs require those values locally in the process environment before any HTTPS request is made, so moving them to OneCLI without code changes can break the integration. Handle Anthropic here; leave other integrations unchanged unless the codebase has been explicitly updated to support proxy-only auth for that service.

### If no credentials found in .env

No migration needed. Proceed to register credentials fresh.

Check if OneCLI already has an Anthropic secret:
```bash
onecli secrets list
```

If an Anthropic secret already exists, skip to Phase 4.

Otherwise, register credentials using the same flow as `/setup`:

AskUserQuestion: Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

1. **Claude subscription (Pro/Max)** — description: "Uses your existing Claude Pro or Max subscription. You'll run `claude setup-token` in another terminal to get your token."
2. **Anthropic API key** — description: "Pay-per-use API key from console.anthropic.com."

#### Subscription path

Tell the user to run `claude setup-token` in another terminal and copy the token it outputs. Do NOT collect the token in chat.

Once they have the token, AskUserQuestion with two options:

1. **Dashboard** — description: "Best if you have a browser on this machine. Open ${ONECLI_URL} and add the secret in the UI. Use type 'anthropic' and paste your token as the value, then set `ANTHROPIC_AUTH_MODE=oauth` in `.env`."
2. **CLI** — description: "Best for remote/headless servers. Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_TOKEN --host-pattern api.anthropic.com`"

After the secret is registered, ensure `.env` contains `ANTHROPIC_AUTH_MODE=oauth`.

#### API key path

Tell the user to get an API key from https://console.anthropic.com/settings/keys if they don't have one.

AskUserQuestion with two options:

1. **Dashboard** — description: "Best if you have a browser on this machine. Open ${ONECLI_URL} and add the secret in the UI, then set `ANTHROPIC_AUTH_MODE=api-key` in `.env`."
2. **CLI** — description: "Best for remote/headless servers. Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_KEY --host-pattern api.anthropic.com`"

After the secret is registered, ensure `.env` contains `ANTHROPIC_AUTH_MODE=api-key`.

#### After either path

Ask them to let you know when done.

**If the user's response happens to contain a token or key** (starts with `sk-ant-` or looks like a token): handle it gracefully — run the `onecli secrets create` command with that value on their behalf.

**After user confirms:** verify with `onecli secrets list` that an Anthropic secret exists. If not, ask again.

## Phase 4: Build and restart

```bash
npm run build
```

If build fails, diagnose and fix. Common issue: `@onecli-sh/sdk` not installed — run `npm run deps:install` first.

Restart the service:
- Use `npm run service:restart`

## Phase 5: Verify

Check logs for successful OneCLI integration:

```bash
tail -30 logs/nanoclaw.log | grep -i "onecli\|gateway"
```

Expected: `OneCLI gateway config applied` messages when containers start.

If the service is running and a channel is configured, tell the user to send a test message to verify the agent responds.

Tell the user:
- OneCLI Agent Vault is now managing credentials
- Anthropic credentials no longer need to live in `.env`; set `ANTHROPIC_AUTH_MODE` to `oauth` or `api-key` so NanoClaw knows which placeholder auth flow to use
- Explicit `CONTAINER_SECRET_*` values are still passed into containers as environment variables by design; they are not managed by OneCLI automatically
- To manage secrets: `onecli secrets list`, or open ${ONECLI_URL}
- To add rate limits or policies: `onecli rules create --help`

## Troubleshooting

**"OneCLI gateway not reachable" in logs:** The gateway isn't running. Check with `curl -sf ${ONECLI_URL}/health`. Start it with `onecli start` if needed.

**Container gets no credentials:** Verify `ONECLI_URL` is set in `.env`, `ANTHROPIC_AUTH_MODE` matches the registered secret type (`oauth` or `api-key`), and the gateway has an Anthropic secret (`onecli secrets list`).

**Old .env credentials still present:** This skill should have removed them. Double-check `.env` for `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_AUTH_TOKEN` and remove them manually if still present.

**Port 10254 already in use:** Another OneCLI instance may be running. Check with `lsof -i :10254` and kill the old process, or configure a different port.
