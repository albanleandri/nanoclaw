# NanoClaw Documentation

For this fork, the current implementation references in this directory are
authoritative. The upstream public site at
[docs.nanoclaw.dev](https://docs.nanoclaw.dev) may not describe fork-specific
provider, Telegram, orchestration, or operator behavior.

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

`SPEC.md`, `REQUIREMENTS.md`, `SDK_DEEP_DIVE.md`, and the model-neutral
assessment/implementation plan are design history and planning material. They
are useful context but are not substitutes for the current architecture,
schema, provider, and operations references above.
