# NanoClaw V1 → V2 Migration Guide

Generated: 2026-05-14  
V1 Base (upstream/main fork point): `934f063aff5c30e7b49ce58b53b41901d3472a3e`  
HEAD at generation: `e0f4aa4` (feat: reassign pool bot channels and add @pinova_ai_swarm_5_bot)  
Upstream v2 HEAD: `upstream/v2` (latest as of fetch)  
Migration branch available: `upstream/migrate/v1-to-v2`

---

## Overview

This fork has **175 commits** and **126 changed files** on top of V1 upstream — it's a heavily customized financial AI platform. V2 is an architectural rewrite with 10 breaking changes. The migration cannot be done via `git merge` or `/update-nanoclaw`; it requires reapplying customizations onto a clean V2 base.

**Recommended path:** Use the upstream `migrate-v2.sh` script to bootstrap a clean V2 sibling directory, then reapply customizations as described in this guide.

**Estimated effort:** 2–4 hours of focused work, primarily in Sections 3 and 5.

**Model split:** Use **Opus 4.7** (`claude-opus-4-7`) for the high-judgment sections (3, 5.4, 5.7, 5.12) where intent must be reasoned through rather than mechanically applied. Use **Sonnet 4.6** (`claude-sonnet-4-6`) for the mechanical sections (5.3, 5.5, 5.8, 5.9, and Section 6 steps 4–5 and 8–10). Each section below is tagged accordingly.

---

## Section 1 — V2 Breaking Changes and Their Impact on This Fork

### 1.1 Entity Model Rewrite [HIGH IMPACT]

V2 replaces channel-level privilege with user-level privilege. Users, roles (owner/admin), messaging groups, and agent groups are now separate tracked entities. Old "main channel = admin" rule is gone.

**Impact on this fork:** The `groups/telegram_main/` directory contains `AGENT_TEAMS.md` and `GROUP_MANAGEMENT.md` referencing bot management patterns. These may reference admin checks that relied on channel identity. Review these files after migration for anything that assumed channel = identity.

### 1.2 Two-DB Session Split [HIGH IMPACT — Data Migration Required]

V1 uses `store/messages.db`. V2 uses two DBs per session: `inbound.db` (host writes, container reads) and `outbound.db` (container writes, host reads). Upstream's TypeScript migration driver (`setup/migrate.ts`) handles this automatically.

**Impact:** The `scripts/backup-dbs.mjs` and `scripts/backup.sh` backup scripts explicitly name `messages.db`. After migration, update these to back up `inbound.db`, `outbound.db`, and any other V2 DB names. Also back up `investments.db` and `polymarket_cache.db` (custom DBs — these are not migrated by the upstream script).

### 1.3 Channels Moved to Separate Branch [MEDIUM IMPACT]

Telegram, WhatsApp, etc. are no longer in V2 trunk. They live on the `channels` branch and must be installed via `/add-<channel>` skills after V2 setup.

**Impact:** This fork uses Telegram heavily (bot pooling, multi-bot, telegram_main group). After V2 setup, run `/add-telegram` and then reapply all Telegram customizations from Section 5.4.

### 1.4 OneCLI as Sole Credential Path [HIGH IMPACT]

V2 removes the built-in credential proxy entirely. All credential injection now flows through OneCLI Agent Vault (`/init-onecli`).

**Impact:** This fork has a substantial custom `src/credential-proxy.ts` (198 lines) implementing OAuth auto-refresh and multi-mode auth. In V2, this is entirely replaced by OneCLI. The `CONTAINER_SECRET_PROTON_ICAL_URL` forwarding and all other `CONTAINER_SECRET_*` vars will need to be migrated to OneCLI vault entries.

### 1.5 Agent-Runner Composition Model Changed [MEDIUM IMPACT]

Per-group `agent-runner-src/` overlays are gone. All groups mount the same agent-runner read-only. Per-group customization flows through composed `CLAUDE.md` (shared base + per-group fragments, injected at runtime).

**Impact:** This fork uses an `AGENTS.override.md` system for agent routing (discovered in `container/agent-runner/` and `groups/`). This system may conflict with V2's fragment-based composition. Review `container/agent-runner/AGENTS.override.md` and `groups/AGENTS.override.md` after migration.

### 1.6 Agent-Runner Runtime: Node → Bun [LOW IMPACT]

The container now runs Bun instead of Node. Host-side stays Node + pnpm.

**Impact:** Low — but the `container/Dockerfile` custom Python packages (`yfinance`, `pandas`, `financedatabase`, `curl_cffi`) must be re-added to the V2 Dockerfile. See Section 5.2.

### 1.7 Install Flow Changed [LOW IMPACT]

`bash nanoclaw.sh` is the new standard installer. The `/setup` skill still works. The `setup/register.ts` and `setup/verify.ts` files were customized in this fork — these will be replaced by V2's versions and the custom logic should be reviewed.

### 1.8 Three-Level Channel Isolation (New Feature) [LOW IMPACT]

Channels now support `session_mode: 'shared'` and `session_mode: 'agent-shared'`. This is new capability; no existing config will break, but the Telegram bot pool setup in this fork may benefit from using the new isolation modes.

---

## Section 2 — Applied Upstream Skills to Reapply

After the V2 base is set up, merge these skill branches in order:

| Skill | Branch | Notes |
|-------|---------|-------|
| channel-formatting | `skill/channel-formatting` | Check for V2 compat; this fork also has custom `src/text-styles.ts` (see Section 5.5) |
| compact | `skill/compact` | Likely V2-compatible, low risk |
| native-credential-proxy | `skill/native-credential-proxy` | **Do NOT merge** — V2 replaces credential proxy with OneCLI. Skip this skill. |
| ollama-tool | `skill/ollama-tool` | Check if Ollama is still desired; custom `OLLAMA_ADMIN_TOOLS` gating (see Section 5.6) |

**Skipped skills (not applied in V1, not needed):** `a2a-return-path`, `apple-container`, `emacs`, `migrate-from-openclaw`, `qmd`, `setup-dynamic-context`, `wiki`

---

## Section 3 — Custom Container Skills Submodule [HIGHEST RISK] `[Opus]`

This fork maintains a **private submodule** at `container/skills/` (not upstream). It contains the custom investment/trading agents:

- `agent-browser` — browsing capability
- `capabilities` — runtime capability detection
- `slack-formatting` — Slack output formatting
- `status` — agent status reporting
- And the full investment suite (due diligence, technical analysis, Polymarket researcher, portfolio orchestrator, etc.)

**How to apply:**

1. After V2 setup, clone or copy your private `container/skills` repo into the V2 tree as a submodule at the same path.
2. Run `npm run container:build` — the Dockerfile must already have the Python packages re-added (Section 5.2) before this step.
3. Verify the submodule commit hash matches what was on V1 HEAD.

**Risk:** If V2's agent-runner has a different IPC protocol or changed how container skills are loaded, the submodule skills may need updates. Compare `container/agent-runner/src/index.ts` in V2 against V1's version before re-attaching the submodule.

---

## Section 4 — Custom Group Data (Preserve As-Is)

These directories contain data and state — do **not** modify them during migration. The upstream migration driver preserves them:

- `groups/telegram_main/` — conversations, memory, `investments.db`, `polymarket_cache.db`
- `store/` — migrated automatically by `setup/migrate.ts` to V2 DB format
- `data/` — preserved as-is

After migration, verify `investments.db` and `polymarket_cache.db` are accessible in the V2 group directory. These are custom DBs not touched by the migration driver.

---

## Section 5 — Customizations to Reapply

### 5.1 Entity Model and Group Configuration `[Sonnet]`

**Intent:** `groups/main/CLAUDE.md` and `groups/global/CLAUDE.md` contain persona, behavior, and financial-domain knowledge. `groups/main/GROUP_MANAGEMENT.md` and `groups/main/TASK_SCRIPTS.md` document operator workflows.

**Files:** `groups/main/CLAUDE.md`, `groups/global/CLAUDE.md`, `groups/main/GROUP_MANAGEMENT.md`, `groups/main/TASK_SCRIPTS.md`

**How to apply:** After V2 sets up its own `CLAUDE.md` fragments, copy the user-specific behavior sections (persona, domain context, financial topics) from the V1 versions into the new V2 fragment structure. Do not copy the whole file verbatim — V2's CLAUDE.md composition model has changed. Look at `docs/module-fragments.md` in V2 for the new format.

---

### 5.2 Dockerfile Python Dependencies [REQUIRED] `[Sonnet]`

**Intent:** The container needs Python packages for financial data fetching. Yahoo Finance anti-blocking requires `curl_cffi`. `financedatabase` provides security metadata.

**Files:** `container/Dockerfile`

**How to apply:**

In the V2 Dockerfile's apt-get block, add `python3` and `python3-pip`, then install Python packages:

```dockerfile
RUN apt-get update && apt-get install -y \
    ... (existing packages) \
    python3 \
    python3-pip \
    && pip3 install --break-system-packages requests anthropic yfinance pandas financedatabase curl_cffi \
    && rm -rf /var/lib/apt/lists/*
```

This must be done **before** `npm run container:build`.

---

### 5.3 Backup Scripts `[Sonnet]`

**Intent:** Automated local backup with 3-rotation policy, excluding credentials.

**Files:** `scripts/backup-dbs.mjs`, `scripts/backup.sh`, `scripts/restore.sh`

**How to apply:**

1. Copy all three scripts from the V1 tree to the same paths in V2.
2. Update `backup-dbs.mjs` and `backup.sh` to reference V2 DB names:
   - Replace `messages.db` → `inbound.db` and `outbound.db`
   - Keep `investments.db` and `polymarket_cache.db` as-is (custom DBs)
3. Register in V2's `package.json` scripts if they were registered in V1's.

---

### 5.4 Telegram Bot Pool Management [HIGH COMPLEXITY] `[Opus]`

**Intent:** Deterministic bot assignment via `bot_index` so each group always gets the same bot identity. Supports targeting a specific bot (not just round-robin). Multi-bot pool with `@pinova_ai_swarm_*_bot` bots.

**Files:** `src/channels/telegram.ts`, `src/index.ts`, `groups/telegram_main/AGENT_TEAMS.md`

**How to apply:**

1. After applying `/add-telegram` on V2, compare `src/channels/telegram.ts` in V2 against V1's version using `git diff`.
2. The key custom behaviors to port:
   - Deterministic `bot_index` pool assignment logic
   - Specific bot targeting (override round-robin)
   - Markdown sanitization for Telegram output
3. The `AGENT_TEAMS.md` in `groups/telegram_main/` documents the current bot assignments — copy this file to the equivalent V2 group directory after setup.
4. Environment variables: all `TELEGRAM_BOT_TOKEN_*` variables from `.env` carry over unchanged.

---

### 5.5 Channel-Aware Text Formatting `[Sonnet]`

**Intent:** Outbound messages are formatted per-channel (WhatsApp markdown, Telegram MarkdownV2, Slack mrkdwn). Lives in `src/text-styles.ts` alongside the `channel-formatting` skill.

**Files:** `src/text-styles.ts`

**How to apply:**

After merging `skill/channel-formatting` on V2, check if V2's skill version already includes `text-styles.ts`. If not, copy the V1 `src/text-styles.ts` into V2 and verify imports in `src/router.ts` still resolve.

---

### 5.6 Ollama Gated Admin Tools `[Sonnet]`

**Intent:** Ollama model management commands (list, pull, delete models) are gated behind `OLLAMA_ADMIN_TOOLS=true` env var to prevent accidental model operations.

**Files:** `container/skills/` (Ollama skill files), `.env.example`

**How to apply:**

After merging `skill/ollama-tool` on V2:
1. Add `OLLAMA_ADMIN_TOOLS=` to `.env.example` with a comment explaining the gate.
2. Verify the gating logic in the skill files — if it was in the submodule (Section 3), it will come back with the submodule. If it was in the skill SKILL.md, re-add the env var check.

---

### 5.7 Credential Proxy → OneCLI Migration [BREAKING CHANGE HANDLER] `[Opus]`

**Intent:** V1 had a custom `src/credential-proxy.ts` with OAuth auto-refresh, API key mode, and OneCLI pass-through. V2 replaces this with OneCLI as the sole path.

**How to apply:**

1. Do **not** copy `src/credential-proxy.ts` or `src/claude-credentials.ts` to V2.
2. Run `/init-onecli` on V2 to initialize the vault.
3. Migrate credentials currently in `.env`:
   - `ANTHROPIC_API_KEY` → `onecli vault set anthropic-api-key`
   - `CLAUDE_CODE_OAUTH_TOKEN` → managed by OneCLI automatically after `/init-onecli`
4. `CONTAINER_SECRET_PROTON_ICAL_URL` → add to OneCLI vault as a container secret.
5. Any other `CONTAINER_SECRET_*` variables → migrate to OneCLI vault entries.
6. After OneCLI is running, remove raw credential lines from `.env`.

---

### 5.8 Proton Calendar Integration `[Sonnet]`

**Intent:** Morning briefing agent reads a Proton Calendar iCal URL to generate a daily briefing. The URL is injected into the container as `CONTAINER_SECRET_PROTON_ICAL_URL`.

**Files:** `.env` (credential), `docs/superpowers/plans/calendar-morning-briefing.md`, `docs/superpowers/specs/` (design spec)

**How to apply:**

1. The implementation plan and spec docs can be copied verbatim to V2's `docs/` tree — they're operator reference, not code.
2. The `CONTAINER_SECRET_PROTON_ICAL_URL` value must be migrated to OneCLI vault (see Section 5.7).
3. The agent skill itself lives in the `container/skills` submodule (Section 3) — it will return with the submodule.

---

### 5.9 Investment Suite Plans and Specs `[Sonnet]`

**Intent:** Documentation for the stock analysis, portfolio orchestration, Polymarket, and macro analyst features.

**Files:** `docs/superpowers/plans/` (7 plan files), `docs/superpowers/specs/` (7 spec files)

**How to apply:** Copy these directories verbatim to V2. They are operator reference docs, not code.

---

### 5.10 Context Optimization (Progressive Disclosure) `[Sonnet]`

**Intent:** Reduced always-loaded context by ~80% by restructuring CLAUDE.md to use progressive disclosure patterns rather than loading all instructions upfront.

**Files:** `groups/main/CLAUDE.md`, `groups/global/CLAUDE.md`

**How to apply:** Apply the same progressive disclosure structuring to the V2 CLAUDE.md fragments after copying content from V1 (see Section 5.1). Do not restore the verbose V1 layout.

---

### 5.11 CI Workflow `[Sonnet]`

**Intent:** Custom GitHub Actions CI (`.github/workflows/ci.yml`).

**How to apply:** Compare V1's CI file against V2's. If V2 ships its own CI, merge the V1-specific steps (any financial-tool-specific lint or test hooks) rather than replacing wholesale.

---

### 5.12 AGENTS.override.md System `[Opus]`

**Intent:** Routing logic for which agent handles which request type, expressed as overrides layered on top of the base AGENTS.md. Used at both the group level and inside the container.

**Files:** `groups/AGENTS.override.md`, `container/agent-runner/AGENTS.override.md`

**How to apply:**

1. Check if V2 retains the override file convention. If yes, copy the override files.
2. If V2 uses a different composition mechanism (CLAUDE.md fragments), translate the override logic into the new format.
3. This is the highest-ambiguity item — verify behavior after migration with a test message.

---

## Section 6 — Migration Steps (Ordered)

Execute in this order:

1. `[Sonnet]` **Create safety net** on V1:
   ```bash
   git tag pre-v2-migration-$(date +%Y%m%d)
   git branch backup/pre-v2-migration
   ```

2. `[Sonnet]` **Run the upstream migration bootstrap** (from a sibling directory):
   ```bash
   cd ~
   git clone https://github.com/qwibitai/nanoclaw.git nanoclaw-v2
   cd nanoclaw-v2
   bash migrate-v2.sh ~/nanoclaw   # points to your V1 tree
   ```
   This: installs V2 deps, migrates `store/messages.db` to the two-DB format, generates a V2-side migration guide.

3. `[Opus]` **Apply `/init-onecli`** in the V2 tree and migrate all credentials (Section 5.7).

4. `[Sonnet]` **Re-add Telegram** via `/add-telegram`, then switch to Opus for applying Telegram pool customizations (Section 5.4).

5. `[Sonnet]` **Apply Dockerfile Python deps** (Section 5.2).

6. `[Opus]` **Re-attach `container/skills` submodule** (Section 3) — verify IPC compatibility before committing.

7. `[Sonnet]` **Merge skill branches** (Section 2) — in order: `channel-formatting`, `compact`, `ollama-tool`. Skip `native-credential-proxy`.

8. `[Sonnet]` **Copy and adapt CLAUDE.md group content** (Sections 5.1, 5.10).

9. `[Sonnet]` **Copy backup scripts**, update DB names (Section 5.3).

10. `[Sonnet]` **Copy docs** (Sections 5.8, 5.9).

11. `[Opus]` **Validate AGENTS.override.md routing** (Section 5.12) — compare V1 logic against V2's fragment model and translate.

12. `[Sonnet]` **Build and test**:
    ```bash
    npm run deps:install
    npm run container:build
    npm run build
    npm test
    ```

13. `[Sonnet]` **Smoke test** — send a test message, verify the bot responds with the correct persona and the investment agents are reachable.

14. `[Sonnet]` **Restart service** and monitor logs for 15 minutes.

15. `[Sonnet]` **Rollback** if anything is wrong: `git reset --hard pre-v2-migration-<date>` in the V1 tree and restart.

---

## Section 7 — What Does NOT Need to Change

- `.env` values (except credentials migrated to OneCLI)
- `groups/telegram_main/` data files, `investments.db`, `polymarket_cache.db`
- Private `container/skills` submodule code (copy as-is)
- `docs/superpowers/` plan and spec files (copy as-is)
- `scripts/backup-*.sh` logic (only DB names change)

---

## Section 8 — Risk Register

| Item | Risk | Mitigation |
|------|------|-----------|
| Container skills submodule IPC compatibility | HIGH | Compare V2 agent-runner IPC protocol before re-attaching |
| AGENTS.override.md system | HIGH | Verify routing behavior with a test message after migration |
| Telegram bot pool logic | MEDIUM | Port incrementally, test each bot after migration |
| Credential proxy removal | MEDIUM | Use `/init-onecli` before anything else; test all secret forwarding |
| Backup scripts DB names | LOW | Simple find-and-replace after migration |
| Dockerfile Python packages | LOW | Exact pip install command is known |
