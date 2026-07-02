# Upstream Review — 2026-07-02

## Scope and comparison basis

Upstream was fetched from `https://github.com/qwibitai/nanoclaw.git` on
2026-07-02. `upstream/main` was at `aecad864` (`2.1.24`).

This fork is not maintained as a linear merge of upstream. Its Git merge base
with `upstream/main` is the v1-era commit `479ca166`, 1,866 upstream commits
behind current upstream, while this fork has independently ported and extended
the v2 architecture. A direct `git merge upstream/main` would therefore mix two
independent v2 histories and is not a useful integration strategy.

The practical baseline for this review is:

- this fork's explicit upstream hardening port, `cf151ceb`, dated 2026-06-26;
- upstream main at `2afbd182`, the last mainline state available on that date;
- upstream changes from `2afbd182..aecad864`;
- newly advertised upstream feature branches that materially overlap this
  fork's provider, setup, and skill architecture.

Patch applicability below was checked with `git apply --check` against this
fork. "Clean" means textual application succeeds, not that the change is
automatically safe to ship. "Conflict" includes context drift or an overlapping
local implementation that requires a manual port.

## Executive recommendation

Do **not** merge `upstream/main`.

Make two separate integration changes, in this order:

1. **Port the inbox symlink-containment fix immediately.** It closes a real host
   filesystem write escape still present in both channel attachment ingestion
   and agent-to-agent target attachment forwarding.
2. **Upgrade the Claude SDK and CLI in an isolated dependency change.** Do not
   combine this with the security fix; validate the fork's Claude event
   translation, terminal-marker ordering, follow-up handling, and coverage
   before deployment.

Correction after implementation-level TDD: upstream's messaging-group
`instance` fix is **not applicable** to this fork. This fork has no
`messaging_groups.instance` column or matching migration; registered adapter
names and Telegram's explicit `bot_index` provide different routing semantics.

Treat agent templates as the most valuable new feature, but implement them as a
fork-native design after the urgent fixes. The upstream implementation assumes
a less strict skill and provider model than this fork. Its useful contract is
"provider-neutral instructions + MCP declarations + skills", but those inputs
must pass this fork's capability compilation, manifest approval, provider
profile, and generated `CLAUDE.md`/`AGENTS.md` paths.

Defer Slack Socket Mode unless Slack is installed here. Watch, but do not adopt,
the unmerged global-provider-default and structured-skill-format branches.

## Upstream main changes

### 1. Inbox symlink containment — adopt now

Upstream commits:

- `36afa408` — harden the agent-to-agent target inbox;
- `dd1d0e56` — share the guard and harden channel-inbound attachment writes.

Why it matters here:

- The local channel path checks `inbox/<message-id>` but calls
  `realpathSync(inboxRoot)` after path creation. If the writable session's
  `inbox` root is already a symlink, both the write and the containment baseline
  follow the same escaped root, so the check passes.
- The local agent-to-agent path creates the target inbox recursively and uses
  ordinary `copyFileSync`, with no target-root symlink rejection and no
  exclusive destination write.
- A compromised runner can therefore pre-place a symlink in its writable
  session tree and induce the host to write attachment bytes to another
  host-writable location.

Conflict assessment:

- `36afa408` textually applies cleanly.
- After that patch, `dd1d0e56` conflicts in `src/session-manager.ts` because
  this fork has independently changed session and attachment handling.
- The combined fix should be manually ported as one reviewable change, including
  upstream's shared inbox guard and regressions for a symlinked inbox root,
  message directory, and destination file.

Recommendation: **P0 manual port now.** Do not settle for applying only
`36afa408`; that leaves the ordinary channel-inbound path vulnerable.

### 2. `ncl messaging-groups create` instance default — not applicable

Upstream commit: `0d841bcd`.

Upstream adds a generic `defaultFrom` column rule and declares
`instance` to default from `channel_type`.

Implementation-level verification corrected the initial review: this fork does
not contain upstream's messaging-group-instance migration or column. Its
`messaging_groups` identity remains `(channel_type, platform_id)`. The built-in
Telegram adapters register distinct channel names, while pool delivery requires
an explicit `bot_index`.

Conflict assessment: the patch applies textually because it adds generic CRUD
metadata, but it would target a column absent from this fork and fail at
runtime. Adding the complete upstream migration would be a new routing-model
change, not a bug fix.

Recommendation: **do not adopt** without a separate design for multi-instance
channel identity and migration semantics.

### 3. Local agent templates — adopt the contract, redesign the integration

Upstream commit: `411f5e71`.

The feature adds local folder templates and
`ncl groups create --template <ref>`. A template can stamp:

- provider-neutral standing instructions;
- additional context files;
- MCP server declarations;
- per-group skills.

Why it matters here:

- This fork already treats provider identity separately from the agent group,
  generates both `CLAUDE.md` and `AGENTS.md`, and supports DB-backed per-group
  runtime configuration. A provider-neutral reusable agent definition fits that
  direction.
- It would reduce repeated setup for specialized agents and make a controlled
  catalog of agent roles practical.

Why upstream cannot be taken verbatim:

- This fork's skill activation is catalog-selected, content-hashed,
  approval-gated, and capability-compiled. Upstream copies template skills into
  provider-specific group stores; that bypasses the fork's single skill catalog
  and provenance gate.
- MCP declarations must be normalized into this fork's container config and
  rejected when the selected runtime or local environment cannot satisfy their
  capabilities.
- This fork has a first-class provider-profile model and two generated
  provider-native instruction documents. Persona composition must feed the
  existing neutral profile/document generator, not add a Claude-first side
  channel.
- Group creation overlaps local orchestration, delegation, permissions, and
  runtime configuration changes.

Conflict assessment: the patch conflicts in `CLAUDE.md`, `README.md`,
`src/claude-md-compose.ts`, its existing test file, and
`src/cli/resources/groups.ts`. New template parser files are additive, but the
runtime integration is a semantic conflict.

Recommendation: **P2 fork-native port**, with this narrower design:

1. Parse and validate a local-only template reference with containment checks.
2. Store neutral instructions and context in the group workspace.
3. Import skill content through the canonical skill catalog/manifest approval
   path; never copy it directly into provider-owned stores.
4. Compile MCP/capability requirements before the first wake and fail closed.
5. Apply provider/profile selection separately from the template.
6. Generate both provider-native instruction documents through the existing
   neutral composition path.

### 4. Claude agent SDK and Claude Code bump — upgrade separately

Upstream commit: `91ebc9de`.

Upstream moves:

- `@anthropic-ai/claude-agent-sdk` from `^0.3.170` to `^0.3.197`;
- `@anthropic-ai/sdk` from `^0.100.0` to `^0.108.0`;
- Claude Code from `2.1.170` to `2.1.197`.

This fork is currently further behind on the agent SDK (`^0.3.154`) and already
adds Codex to `container/cli-tools.json`.

Why it matters here:

- Staying close to the runtime SDK used by upstream reduces exposure to already
  fixed provider-stream and CLI issues.
- This fork recently hardened Claude event translation and terminal event
  ordering, so it has a useful regression suite for evaluating the upgrade.

Conflict assessment: the patch conflicts in the runner manifest, Bun lockfile,
and CLI-tools manifest. This is expected dependency drift, not a reason to skip
the upgrade.

Recommendation: **P1 isolated upgrade**, preserving
`@anthropic-ai/claude-agent-sdk` as the runtime. Run the full runner suite,
Claude event-translation tests, follow-up/stream-open tests, terminal-marker
ordering tests, host typecheck, and a fresh-container smoke test. Do not bundle
it with security or template work.

### 5. Slack Socket Mode setup — defer unless Slack is installed

Upstream commit: `cf8478ff`; the matching adapter work is on the upstream
`channels` branch.

The setup flow can choose an outbound WebSocket instead of requiring a public
webhook. That is operationally useful on an SSH-hosted machine behind NAT.

Conflict assessment: the mainline setup patch applies cleanly, but it is not a
complete feature without the corresponding Slack adapter version. This fork
currently ships Telegram, not Slack.

Recommendation: **defer**. If Slack is added, install the adapter and setup
change as one pinned unit and account for the upstream Chat SDK `4.29.0`
version-lock requirement.

### 6. Already present or irrelevant mainline changes

- The newer optional channel-name resolution seam and Telegram implementation
  are already present locally.
- Version bumps, token-count badge updates, and Slack-only documentation do not
  justify a port.

## Upstream feature-branch watchlist

These branches were fetched but are not merged into `upstream/main`, so they
should not be treated as released upstream behavior.

### `feat/global-provider-default`

The branch makes newly created groups inherit an instance-wide
`DEFAULT_AGENT_PROVIDER`.

Relevance: high in principle for a multi-provider fork. However, this fork
selects DB-backed provider profiles, not only provider names, and already has
explicit selection precedence across session, group, profile, and legacy
fields.

Recommendation: **watch, do not port now**. If adopted, define an instance
default **provider profile** with credential/usability validation, stamp it only
at group creation, and never insert it into runtime resolution in a way that
retroactively changes existing groups. This will conflict semantically with
`src/config.ts`, container-config creation, group initialization, delegation,
and setup/provider-profile handling.

### `feat/structured-skill-format`

The branch adds an `nc:` directive parser and a deterministic skill-application
engine, then rewrites channel/provider setup around it.

Relevance: the plan/apply split, idempotency journal, input validation, and
operator gates are useful ideas for reproducible optional feature installation.

Risk and conflict:

- The branch changes 85 files with roughly 6.7k additions and 6.1k deletions.
- It replaces much of the setup/channel flow.
- Its mutation and journaling model is distinct from this fork's runtime skill
  manifest approval, content hashing, and capability compilation.
- It is still an unmerged development branch.

Recommendation: **watch only**. Reassess after upstream merges and stabilizes
the format. If adopted later, keep installation recipes separate from runtime
agent skills and require every installed runtime skill to enter the existing
provenance/capability gate.

## Conflict summary

| Change | Textual result | Integration decision |
| --- | --- | --- |
| A2A target inbox hardening (`36afa408`) | Clean | Port as part of full security fix |
| Shared/channel inbox hardening (`dd1d0e56`) | Conflict in session manager | Manual port now |
| Messaging-group instance default (`0d841bcd`) | Textually clean, schema absent | Do not adopt |
| Slack Socket Mode setup (`cf8478ff`) | Clean | Defer with Slack adapter |
| Claude SDK/CLI bump (`91ebc9de`) | Dependency/lock conflict | Isolated manual upgrade |
| Agent templates (`411f5e71`) | Multiple code/doc conflicts | Fork-native redesign |
| Global provider default branch | Semantic conflicts | Watch; prefer profile default |
| Structured skill format branch | Broad setup/skill conflicts | Watch only |

## Proposed integration sequence

1. Port both inbox-root and per-message containment guards plus exclusive writes;
   run focused security tests and the host suite.
2. Upgrade Claude dependencies in a standalone change and run runner/host
   verification plus a fresh-container smoke test.
3. Write a short fork-native template contract before implementation, centered
   on neutral instructions, approved catalog skills, capability-checked MCP
   declarations, and separate provider-profile selection.
4. Re-fetch upstream after the global-provider-default and structured-skill
   branches land on main; do not build against their current branch contracts.
