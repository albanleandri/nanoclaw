<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  An AI assistant that runs agents securely in their own containers. Lightweight, built to be easily understood and completely customized for your needs.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">docs</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="repo tokens" valign="middle"></a>
</p>

---

## Why I Built NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level (allowlists, pairing codes) rather than true OS-level isolation. Everything runs in one Node process with shared memory.

NanoClaw provides that same core functionality, but in a codebase small enough to understand: one host process, one container-side runner, and a small set of explicit boundaries. Agents run in their own Linux containers with filesystem isolation, not merely behind permission checks.

## Quick Start

```bash
git clone https://github.com/nanocoai/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash nanoclaw.sh
```

`nanoclaw.sh` walks you from a fresh machine to a named agent you can message. It installs Node, pnpm, and Docker if missing, registers the initial Claude credential with OneCLI, builds the agent container, and pairs your first channel (Telegram, Discord, WhatsApp, or a local CLI). If a step fails, Claude Code is invoked automatically to diagnose and resume from where it broke.

<details>
<summary><strong>Migrating from NanoClaw v1?</strong></summary>

Run from a fresh v2 checkout next to your v1 install:

```bash
git clone https://github.com/nanocoai/nanoclaw.git nanoclaw-v2
cd nanoclaw-v2
bash migrate-v2.sh
```

`migrate-v2.sh` finds your v1 install (sibling directory, or `NANOCLAW_V1_PATH=/path/to/nanoclaw`), migrates state into the v2 checkout, then `exec`s into Claude Code to finish the parts that need judgment (owner seeding, CLAUDE.local.md cleanup, fork-customisation replay).

Run the script directly, not from inside a Claude session — the deterministic side needs interactive prompts and real shell I/O for Node/pnpm bootstrap, Docker, OneCLI, and the container build.

**What it does:** merges `.env`, seeds the v2 DB from `registered_groups`, copies group folders + session data + scheduled tasks, installs the channel adapters you select, copies channel auth state (including Baileys keystore + LID mappings for WhatsApp), builds the agent container.

**What it doesn't:** flip the system service. Pick *"switch to v2"* at the prompt, or do it manually after testing — your v1 install is left untouched.

See [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md) for what's different and [docs/migration-dev.md](docs/migration-dev.md) for development notes.

</details>

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full NanoClaw codebase, just ask Claude Code to walk you through it.

**Secure by isolation.** Agents run in Linux containers and they can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, NanoClaw is designed to be bespoke. You make your own fork and have Claude Code modify it to match your needs.

**Customization = code changes.** NanoClaw avoids a large configuration surface. Runtime choices such as provider, model, skills, MCP servers, CLI scope, and shared resources are DB-backed and materialized at spawn; deeper behavior changes are ordinary code changes in a small codebase.

**AI-native, hybrid by design.** The install and onboarding flow is an optimized scripted path, fast and deterministic. When a step needs judgment, whether a failed install, a guided decision, or a customization, control hands off to Claude Code seamlessly. Beyond setup there's no monitoring dashboard or debugging UI either: describe the problem in chat and Claude Code handles it.

**Skills over features.** Trunk stays focused on the registry, orchestration, and the provider/runtime paths that are part of the base system. Optional channel adapters and provider integrations are installed by skills from long-lived branches such as `channels` and `providers`. You run `/add-telegram`, `/add-opencode`, etc. and the skill copies exactly the module(s) you need into your fork. No feature you didn't ask for.

**Provider-aware, not provider-shaped.** The container runner stays on Bun and `@anthropic-ai/claude-agent-sdk`, with Claude as the default provider. NanoClaw also has provider adapter boundaries for Codex-like and future runners: provider, model, effort, skills, MCP servers, and shared resources are selected per agent group and materialized into a neutral agent profile plus provider-native project docs.

## What It Supports

- **Multi-channel messaging** — channel adapters are installed on demand with `/add-<channel>` skills. Telegram support is present in this tree; other adapters such as Discord, Slack, WhatsApp, GitHub, Linear, Matrix, Google Chat, Webex, WeChat, Microsoft Teams, iMessage, and email belong to channel skills or forks.
- **Flexible isolation** — connect each channel to its own agent for full privacy, share one agent across many channels for unified memory with separate conversations, or fold multiple channels into a single shared session so one conversation spans many surfaces. Pick per channel via `/manage-channels`. See [docs/isolation-model.md](docs/isolation-model.md).
- **Per-agent workspace** — each agent group has a durable workspace, generated provider-native docs (`CLAUDE.md` for Claude, `AGENTS.md` for Codex), a materialized `container.json` with a neutral `agentProfile`, and only the mounts you allow. Nothing crosses the boundary unless you wire it to.
- **Scheduled tasks** — one-shot or recurring jobs that wake the selected agent/provider and can message you back
- **Web access** — search and fetch content from the web
- **Container isolation** — agents are sandboxed in Docker (macOS/Linux/WSL2), with optional [Docker Sandboxes](docs/docker-sandboxes.md) micro-VM isolation or Apple Container as a macOS-native opt-in
- **Credential security** — agents never hold raw API keys. Outbound requests route through [OneCLI's Agent Vault](https://github.com/onecli/onecli), which injects credentials at request time and enforces per-agent policies and rate limits.

## This Fork vs Upstream

This fork stays close to upstream NanoClaw's host/container/session-DB architecture, but carries a few runtime and operator changes:

- **Provider-neutral runtime profile** — agent identity, provider, model, skills, MCP servers, CLI scope, mounts, and shared resources are materialized into a neutral `agentProfile` at spawn time.
- **First-class Codex runtime path** — Codex support is present in this tree, including provider adapters, generated `AGENTS.md`, Codex CLI install data, and container-side runner support.
- **DB-backed per-group runtime config** — provider, model, effort, skills, MCP servers, CLI scope, and shared resources are selected per agent group instead of living only in instruction files.
- **Shared resources across providers** — shared mounts and resources are resolved once and exposed through provider-specific docs and runtime config.
- **Built-in Telegram adapter and bot-pool routing** — Telegram is included here, with pairing support, Markdown sanitization, and optional pool routing via explicit `bot_index`.
- **Private skills submodule** — fork-specific skills can live in `container/skills/custom` as a private submodule while the public tree stays generic.
- **Durable job/action framework** — host-side long-running jobs can persist progress, expose delivery actions, and report failures through the normal messaging path.
- **Local operator tooling** — helper scripts cover read-only SQLite inspection, backup/restore, token refresh, and systemd service management.

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From a channel you own or administer, you can manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

NanoClaw keeps configuration deliberately small. For behavior changes, tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add a new channel or optional agent provider, prefer a skill. New channel adapters land on the `channels` branch; optional providers land on `providers`. Users install them in their own fork with `/add-<name>` skills, which copy the relevant module(s) into the standard paths, wire the registration, and pin dependencies.

This keeps the base system lean, and every fork stays focused — users get the channels and optional providers they asked for and nothing else.

### RFS (Request for Skills)

Skills we'd like to see:

**Communication Channels**
- `/add-signal` — Add Signal as a channel

## Requirements

- macOS or Linux (Windows via WSL2)
- Node.js 20+ and pnpm 10+ (the installer will install both if missing)
- [Docker Desktop](https://docker.com/products/docker-desktop) (macOS/Windows) or Docker Engine (Linux)
- [Claude Code](https://claude.ai/download) for `/customize`, `/debug`, error recovery during setup, and all `/add-<channel>` skills

## Architecture

```
messaging apps → host process (router) → inbound.db → container (Bun agent-runner, selected provider) → outbound.db → host process (delivery) → messaging apps
```

A single Node host orchestrates per-session agent containers. When a message arrives, the host routes it via the entity model (user → messaging group → agent group → session), writes it to the session's `inbound.db`, and wakes the container. The Bun agent-runner inside the container polls `inbound.db`, invokes the selected provider, and writes responses to `outbound.db`. The host polls `outbound.db` and delivers back through the channel adapter.

Two SQLite files per session, each with exactly one writer — no cross-mount contention, no IPC, no stdin piping. Channel adapters and provider adapters self-register at startup; the base system ships the registry and Chat SDK bridge, while optional adapters are skill-installed per fork.

For the full architecture writeup see [docs/architecture.md](docs/architecture.md); for the three-level isolation model see [docs/isolation-model.md](docs/isolation-model.md).

Key files:
- `src/index.ts` — entry point: DB init, channel adapters, delivery polls, sweep
- `src/router.ts` — inbound routing: messaging group → agent group → session → `inbound.db`
- `src/delivery.ts` — polls `outbound.db`, delivers via adapter, handles system actions
- `src/host-sweep.ts` — 60s sweep: stale detection, due-message wake, recurrence
- `src/session-manager.ts` — resolves sessions, opens `inbound.db` / `outbound.db`
- `src/container-runner.ts` — spawns per-session containers, materializes `container.json`, OneCLI credential injection
- `src/db/` — central DB (users, roles, agent groups, messaging groups, wiring, migrations)
- `src/channels/` — channel adapter infra (adapters installed via `/add-<channel>` skills)
- `src/providers/` — host-side provider config and provider-contributed mounts/env
- `container/agent-runner/` — Bun agent-runner: poll loop, MCP tools, provider abstraction
- `groups/<folder>/` — per-agent-group workspace (generated provider docs, memory/work files, materialized `container.json`)

## FAQ

**Why Docker?**

Docker provides cross-platform support (macOS, Linux and Windows via WSL2) and a mature ecosystem. On macOS, Apple Container is also supported as a lighter-weight native runtime. For additional isolation, [Docker Sandboxes](docs/docker-sandboxes.md) run each container inside a micro VM.

**Can I run this on Linux or Windows?**

Yes. Docker is the default runtime and works on macOS, Linux, and Windows (via WSL2). Just run `bash nanoclaw.sh`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. Credentials never enter the container — outbound API requests route through [OneCLI's Agent Vault](https://github.com/onecli/onecli), which injects authentication at the proxy level and supports rate limits and access policies. You should still review what you're running, but the codebase is small enough that you actually can. See the [security documentation](https://docs.nanoclaw.dev/concepts/security) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. NanoClaw has DB-backed runtime config for providers, models, skills, MCP servers, CLI scope, shared resources, and mounts, but broader behavior is meant to be customized in code rather than hidden behind a generic dashboard. If you prefer additional config files, you can tell Claude Code to add them.

**Can I use third-party or open-source models?**

Yes. Provider is configurable per agent group. Codex support exists in the current provider stack, and optional providers such as OpenCode (`/add-opencode`) or Ollama (`/add-ollama-provider`) can be installed through provider skills.

For one-off Claude-compatible endpoint experiments, `.env` can override the Anthropic endpoint:

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies NanoClaw.

**Why isn't the setup working for me?**

If a step fails, `nanoclaw.sh` hands off to Claude Code to diagnose and resume. If that doesn't resolve it, run `claude`, then `/debug`. If Claude identifies an issue likely to affect other users, open a PR against the relevant setup step or skill.

**What changes will be accepted into the codebase?**

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills on the `channels` or `providers` branch.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes, or the [full release history](https://docs.nanoclaw.dev/changelog) on the documentation site.

## License

MIT

<img referrerpolicy="no-referrer-when-downgrade" src="https://static.scarf.sh/a.png?x-pxid=47894bd5-353b-42fe-bb97-74144e6df0bf" />
