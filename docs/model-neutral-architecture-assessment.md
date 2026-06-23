# Model-Neutral Architecture Assessment

Date: 2026-06-21

## Goal

Move NanoClaw toward a model-neutral architecture and setup path where agent identity, schedules, memory, skills, shared resources, and operator workflows are not coupled to one model provider's runtime conventions.

This does not mean removing Claude, weakening the current Claude path, or replacing the container runner stack. The agent-runner still runs on Bun and keeps `@anthropic-ai/claude-agent-sdk` for the Claude provider. The goal is to keep provider-specific behavior at provider edges, while the capabilities the user depends on remain portable across Claude, Codex, and future provider adapters.

## Why This Matters

The current architecture already supports provider selection and a neutral `agentProfile`, but the most valuable local capabilities are still partly encoded as Claude/Telegram operational habits. That creates three risks:

- **Provider migration risk:** switching a group from Claude to Codex can silently degrade tasks whose prompts assume Claude-only tools, paths, or subagents.
- **Duplicate execution risk:** sharing schedules across providers is currently solved by a local hard-code, not a reusable ownership model.
- **Setup lock-in:** setup and recovery are still Claude-first, so installing or operating a non-Claude primary provider is not yet a first-class path.

The model-neutral direction is about reducing those risks without pretending every model has identical tool semantics.

## Objectives

1. Keep the existing Claude runtime fully supported and stable.
2. Make provider selection a configuration choice, not a rewrite of skills, task prompts, memory paths, and setup instructions.
3. Keep schedule execution single-owner while allowing multiple provider-backed agents to administer the same schedule safely.
4. Move durable state and scripts to provider-neutral paths, especially `/workspace/agent`, `/app/shared/*`, and shared resources.
5. Treat provider-native files (`CLAUDE.md`, `AGENTS.md`, `.claude-fragments/`, `.agents/skills`) as generated compatibility artifacts, not as canonical capability definitions.
6. Make setup credential flow provider-aware: Claude subscription auth remains supported, but Codex/OpenAI and future providers should have explicit setup, verification, and recovery paths.

## Success Criteria

A capability or scheduled task is considered model-neutral enough when:

- It can run from a Claude-owned group and a Codex-owned group without changing its persistent prompt.
- It references provider-neutral state paths, or clearly marks provider-specific paths as compatibility fallbacks.
- It uses NanoClaw MCP/system actions for messaging, scheduling, jobs, questions, and files instead of provider-native substitutes when a NanoClaw tool exists.
- It does not require Claude Code-only `Skill(...)`, `Task`, or `.claude` paths unless it is explicitly classified as Claude-specific.
- Shared schedules have a DB-backed owner/admin model, not hard-coded agent group IDs.
- Setup can create, verify, and document a working provider profile for each supported primary provider.

## Scope Reviewed

This assessment covers the provider-neutrality of:

- host/session DB transport and system actions
- container provider adapters and generated provider-native docs
- selected custom skills under `container/skills/custom`
- shared resources mounted into both Pinova groups
- active scheduled task rows in the current Pinova Claude and Pinova Codex session DBs
- setup and recovery paths that shape first-run provider choice
- channel assumptions that appear in scheduled tasks and skill instructions

It intentionally distinguishes active runtime surfaces from historical/reference material. Active surfaces include `SKILL.md`, task prompts, generated `CLAUDE.md`/`AGENTS.md`, container config, shared-resource instructions, and setup/runtime code. Historical docs, old handoffs, archived plans, and reference notes may contain Claude/Telegram terminology without making the live runtime less portable; those should be inventoried and classified, not automatically treated as blockers.

Out of scope for this assessment: replacing the Claude provider SDK, replacing Bun in the container, redesigning channel adapters, or moving schedules into a central scheduler table. Those could be future projects, but they are not required to make the current capabilities more model-neutral.

## Verification Method

Claims below were verified from local repo state and read-only SQLite inspection on 2026-06-21:

- source inspection with `rg`/`sed` across `README.md`, `setup/`, `src/`, `container/agent-runner/src`, and `container/skills/custom`
- central DB inspection with `scripts/q.ts --readonly data/v2.db`
- session DB inspection with `scripts/q.ts --readonly .../inbound.db`
- comparison of selected skills/shared resources for Pinova and Pinova Codex
- active scheduled task counts from each group's current session DB

Dynamic claims such as live task counts are accurate at verification time and should be regenerated before applying migrations.

## Verified Claims

| Claim | Status | Evidence | Proper solution |
| --- | --- | --- | --- |
| The core DB transport and schedule system-action path are provider-neutral; prompt wording, media rendering, and provider project docs are adapter-dependent. | Verified. | `container/agent-runner/src/poll-loop.ts` formats DB rows and calls the selected `AgentProvider`; `container/agent-runner/src/mcp-tools/scheduling.ts` writes system actions to `messages_out`; `src/modules/scheduling/actions.ts` applies those actions host-side. Provider-native docs are composed separately for Claude/Codex. | Preserve the DB and system-action boundary. Add tests for new providers at the `AgentProvider` and MCP/system-action boundary, and keep provider-native rendering in provider adapters. |
| The provider boundary exists and is real. | Verified. | `container/agent-runner/src/providers/types.ts` defines `AgentProvider`; Claude and Codex implementations live under `container/agent-runner/src/providers/`; docs describe runner core vs provider adapter in `docs/agent-runner-details.md`. | Continue moving SDK auth, sandbox, continuation, approval, and project-doc behavior into provider adapters only. |
| `agentProfile` is neutral but not yet the only source of truth. | Verified. | `docs/agent-profile.md` says providers do not yet depend on `agentProfile` directly and existing top-level `container.json` fields remain compatible. | Keep deriving top-level compatibility fields, but make new capability docs and verifiers read intent from `agentProfile`/`container_configs`, not from provider-native docs. |
| Codex gets provider-native docs and skill links. | Verified. | `src/providers/codex-agents-md.ts` composes `AGENTS.md`; `src/providers/codex.ts` syncs `.agents/skills` links and mounts `AGENTS.md`. | Keep this as an adapter concern. Do not require custom skills to know Codex's mounted skill-link shape. |
| Shared schedule administration is not generic. | Verified. | `src/modules/scheduling/actions.ts` hard-codes `PINOVA_AGENT_GROUP_ID` and `PINOVA_CODEX_AGENT_GROUP_ID`; tests in `src/modules/scheduling/actions.test.ts` cover this exact local pair. | Replace with DB-backed schedule ownership/admin grants. Suggested shape: `schedule_admin_grants(admin_agent_group_id, owner_agent_group_id)` plus owner-session resolution by central DB state. |
| Pinova Claude owns live task rows; Pinova Codex currently has none. | Verified from read-only SQLite at assessment time. | `data/v2-sessions/ag-1778748709932-a8wsn1/.../inbound.db` has 14 active `task` rows; `data/v2-sessions/b3b36ece-a953-42f9-af6c-da0f901c27d6/.../inbound.db` has 0 active `task` rows. | Preserve single-owner execution, but make ownership explicit and inspectable instead of inferred from which session currently has rows. Re-check counts immediately before any prompt migration. |
| The selected skills/resources are aligned between Pinova and Pinova Codex. | Verified from central DB. | Both groups select the same custom skills and `["knowledge","trading-scripts","trading-data","research-notes","docs"]`. | Use this as the base for portability, but repair the instructions inside those skills so the same selection means the same practical capability. |
| Custom skill instructions are still Claude-path-heavy in active skill surfaces. | Verified. | `container/skills/custom/AGENTS.override.md` mandates `/home/node/.claude/skills/`; stock-market and Polymarket active skill instructions reference `/home/node/.claude/skills/...`. Additional historical/reference docs contain more Claude terms and should be classified separately. | Standardize active instructions on `/app/skills/custom/<skill>` for read-only skill sources, `/workspace/agent` for group-local state, and `/app/shared/*` for shared resources. Keep `/home/node/.claude/skills` only as a Claude compatibility note. |
| Stock investing capability is portable in scripts, less portable in orchestration. | Verified. | Python scripts use ordinary file/SQLite/network operations, but `SKILL.md` instructs `Skill("stock-market-investing")`, Claude `Task` subagents, `.claude` paths, `/workspace/group/investments.db`, and Telegram delivery. | Split deterministic scripts from model orchestration. Provide provider-neutral commands and DB paths; replace Claude subagent steps with NanoClaw long-lived agents, explicit MCP delegation, or provider-specific adapters. |
| Polymarket capability is Anthropic application logic, not provider-neutral model logic. | Verified. | `container/skills/custom/polymarket/SKILL.md` documents Anthropic OAuth, Haiku, Sonnet, and Anthropic env expectations. | Classify it honestly as an Anthropic-backed capability, or introduce a small evaluator interface with provider/model settings and tests for equivalent output contracts. |
| Scheduled task prompts are not currently provider-neutral. | Verified. | Live task rows include prompts with `Skill("stock-market-investing")`, Claude-style `Task` references, `.claude` script paths, Telegram `bot_index`, and mixed `/workspace/agent` vs `/app/shared` data paths. | Run a task-prompt migration: rewrite live prompts to provider-neutral commands, shared DB paths, and NanoClaw MCP tools; keep channel-specific delivery explicit where required. |
| Setup remains Claude-first. | Verified. | `README.md` Quick Start says setup registers the initial Claude credential; setup includes `setup/register-claude-token.sh`, Claude handoff/assist code, and Claude timezone fallback. | Make provider selection explicit during setup. Claude remains default, but Codex/OpenAI and future providers need first-class auth, verification, and recovery steps. |

## Target Architecture

### 1. Capability Contract

Each capability should have a provider-neutral contract:

- command or trigger
- required tools
- durable state paths
- shared resource paths
- external credentials
- channel delivery assumptions
- provider-specific fallbacks, if any

The contract should live in skill documentation and be testable by static checks. Provider-native docs should render or point to the same contract, not fork it.

### 2. Schedule Ownership

Replace the local hard-coded shared schedule routing with explicit data:

```sql
CREATE TABLE schedule_admin_grants (
  admin_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
  owner_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  created_by TEXT,
  PRIMARY KEY (admin_agent_group_id, owner_agent_group_id)
);

CREATE INDEX idx_schedule_admin_grants_owner
  ON schedule_admin_grants(owner_agent_group_id);
```

Initial behavior can stay session-DB based:

- task rows remain in the owner session `inbound.db`
- `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, and `update_task` resolve the owner through the grant
- `schedule_task` defaults to the caller's own schedule unless an explicit, authorized owner is requested
- recurrence continues to fan out only in the owner session

A later migration can move schedules to a central table, but that is not required for the first proper fix.

### 3. Provider-Neutral Paths

Use these as canonical instruction paths:

- `/workspace/agent` for persistent group workspace state
- `/workspace/agent/shared/<name>` for group-visible shared resource symlinks
- `/app/shared/<name>` for mounted shared backing resources
- `/app/skills/custom/<skill>` for read-only custom skill source inside the container

Keep these as compatibility paths only:

- `/workspace/group` as the legacy alias for `/workspace/agent`
- `/home/node/.claude/skills` as a Claude compatibility projection
- provider-specific state under `/home/node/.claude`, `/home/node/.codex`, etc.

### 4. Provider-Specific Workflows

Some workflows cannot be made provider-neutral by wording alone. Claude `Task` subagents and Codex app-server turns are different mechanisms. The proper solution is not to pretend they are identical.

Use one of these patterns:

- deterministic script first, provider only for synthesis
- NanoClaw long-lived companion agents via MCP when persistent delegation is needed
- provider-specific adapter instructions for genuinely provider-native behavior
- explicit capability classification: `portable`, `portable-with-adapter`, or `provider-specific`

### 5. Setup

Setup should ask or infer:

- primary provider for the first group
- credential source for that provider
- model/effort defaults
- whether Claude Code is installed for debugging/customization assistant duties

Claude Code can remain the setup recovery assistant, but it should not be implied to be the only possible runtime provider.

## Recommended Work Plan

1. **Add schedule owner grants.**
   Replace `PINOVA_*` constants with DB-backed owner/admin resolution and tests for arbitrary groups.

2. **Create a portability verifier.**
   Static check selected skills and live task prompts for banned or warning-only patterns:
   `/home/node/.claude/skills`, `Skill(`, `Task tool`, `bot_index`, `/workspace/group`, provider model names, and mixed DB paths.

3. **Normalize shared trading paths.**
   Move stock and Polymarket task prompts toward `/app/shared/trading-data/*.db` and scripts under `/app/shared/trading-scripts` or `/app/skills/custom/...`.

4. **Rewrite live scheduled task prompts.**
   Keep the same series IDs and recurrence, but update prompt content in-place through `update_task` or a controlled DB migration.

5. **Classify custom skills.**
   Add a short portability header to each custom skill:
   `portable`, `portable-with-adapter`, or `provider-specific`, with required provider/channel assumptions.

6. **Make setup provider-aware.**
   Add a setup design slice before implementation: provider selection, credential verification, generated docs, and failure handoff behavior.

## Non-Goals

- Do not migrate the agent-runner away from Bun.
- Do not replace `@anthropic-ai/claude-agent-sdk` for the Claude provider.
- Do not remove Claude Code from setup recovery or customization workflows.
- Do not make Telegram-specific delivery disappear; classify it as channel-specific where it is intentional.
- Do not duplicate scheduled task rows into Codex-owned sessions to simulate portability.

## Current Decision

Lean into a model-neutral architecture by making the host/session DB contract, schedule ownership, paths, setup profile, and capability contracts provider-neutral. Keep model-specific behavior isolated in provider adapters and explicitly classified skills.

That is the pragmatic middle: NanoClaw keeps the high-quality Claude path that already works, while the capabilities that matter to the user stop depending on Claude-shaped incidental details.
