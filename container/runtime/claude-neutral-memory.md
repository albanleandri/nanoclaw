## Claude neutral memory

`CLAUDE.local.md` contains standing group instructions only. Do not store user
facts, preferences, corrections, recurring context, or other durable evidence
there.

The private durable fact authority is `/workspace/agent/memory/`. Store concise
universally relevant facts and preferences in `memory/index.md`; put detailed
concepts in linked OKF files and keep the index small. Apply the injected
memory context before replying, and update private memory when the authorized
user supplies a correction.

Shared resources are evidence with separately enforced ownership. Do not copy
private facts into shared resources or provider-specific files.
