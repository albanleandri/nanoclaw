# NanoClaw Documentation

For this fork, the current implementation references in this directory are
authoritative. The upstream public site at
[docs.nanoclaw.dev](https://docs.nanoclaw.dev) may not describe fork-specific
provider, Telegram, orchestration, or operator behavior.

## Documentation ownership

This directory documents the parent NanoClaw repository: host and runner
architecture, databases, setup, security, operations, providers, and behavior
implemented by parent-owned code or group configuration.

`container/skills/custom` is a separate, private Git submodule. Its own `docs/`
directory travels with that repository and contains custom-skill and private
project documentation. Public-safe implementation documentation belongs here;
sensitive, operator-specific, or domain-specific material stays in the private
submodule (or an ignored `*.local.md` file), even when it discusses parent
runtime integration. Do not merge the two documentation trees merely because
the submodule is checked out inside this repository.

Start here:

| Topic                             | Document                                           |
| --------------------------------- | -------------------------------------------------- |
| Current architecture              | [architecture.md](architecture.md)                 |
| Compact diagrams                  | [architecture-diagram.md](architecture-diagram.md) |
| Database overview                 | [db.md](db.md)                                     |
| Central DB schema                 | [db-central.md](db-central.md)                     |
| Session DB schemas                | [db-session.md](db-session.md)                     |
| Provider descriptors/profiles     | [providers.md](providers.md)                       |
| Agent runtime profile             | [agent-profile.md](agent-profile.md)               |
| Agent-runner/provider lifecycle   | [agent-runner-details.md](agent-runner-details.md) |
| Workspace/session isolation       | [isolation-model.md](isolation-model.md)           |
| Build, test, and service commands | [OPERATIONS.md](OPERATIONS.md)                     |
| Backup and restore                | [backup.md](backup.md)                             |
| Debugging                         | [DEBUG_CHECKLIST.md](DEBUG_CHECKLIST.md)           |
| Security                          | [SECURITY.md](SECURITY.md)                         |

## Current fork feature map

The implementation currently includes:

- a Node + pnpm host and a bind-mounted Bun agent-runner that remains on
  `@anthropic-ai/claude-agent-sdk`;
- Claude SDK, Codex app-server, and verified OpenAI-compatible protocol-loop
  runtime paths behind provider descriptors, profiles, and capability
  compilation;
- Telegram in this checkout, with the channel registry and branch-installed
  skill pattern available for other adapters;
- per-session inbound/outbound SQLite transport, DB-backed identity,
  permissions, routing, scheduling, approvals, durable jobs, agent delegation,
  session search, auxiliary routes, and direct orchestration;
- generated per-session provider docs and a neutral `agentProfile`, including
  approved skills, MCP servers, CLI scope, mounts, and shared resources;
- provider-neutral OKF memory with DB-backed rollout state, maintenance fences,
  one filesystem-enforced writer, read-only peer sessions, bounded provider
  delivery, isolated validation, and resumable migration/rollback;
- reconciled shared-resource ownership with one approved writer-owner and
  read-only non-owner grants;
- OneCLI-backed credential injection, optional egress lockdown, redacted
  capability audit, and approval-gated sensitive host actions; and
- Docker as the default container runtime, with Apple Container and Docker
  Sandboxes documented as explicit alternatives.

This is a capability summary, not an assertion that every optional adapter,
provider profile, skill, or container backend is enabled in a given local
deployment. Inspect DB-backed group configuration and installed registrations
for effective runtime state.

`SPEC.md`, `REQUIREMENTS.md`, and `SDK_DEEP_DIVE.md` are design history and
planning material. They are useful context but are not substitutes for the
current architecture, schema, provider, and operations references above.
