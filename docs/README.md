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
| Build, test, and service commands | [OPERATIONS.md](OPERATIONS.md)                     |
| Debugging                         | [DEBUG_CHECKLIST.md](DEBUG_CHECKLIST.md)           |
| Security                          | [SECURITY.md](SECURITY.md)                         |

`SPEC.md`, `REQUIREMENTS.md`, and `SDK_DEEP_DIVE.md` are design history and
planning material. They are useful context but are not substitutes for the
current architecture, schema, provider, and operations references above.
