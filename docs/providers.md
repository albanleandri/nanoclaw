# Provider descriptors and profiles

NanoClaw separates installed provider code from local endpoint configuration:

- A **provider descriptor** states which runtime is installed, its auth/model metadata, and its actual capabilities.
- A **runtime descriptor** identifies the orchestration harness (`claude-sdk`, `codex-app-server`, or `openai-protocol-loop`) and derives its capability and continuation facts from the provider descriptor.
- A **model endpoint profile** is the runtime-neutral view of a DB-backed provider profile.
- A **provider profile** selects a descriptor and adds local settings such as endpoint, API family, model, and a OneCLI secret reference.
- A **container provider** executes turns inside the Bun agent-runner.
- An optional **host contribution** supplies provider-specific mounts or environment.

Claude remains the default. Codex remains a native app-server provider. `openai-compatible` is a generic, text-only endpoint adapter; it is not the Codex runtime.

The runtime/model split is currently additive. Spawn still uses the compatibility provider fields, while the host resolves an `EffectiveRuntimeSelection` in shadow and verifies model, effort, profile, and state-key parity. Explicit runtime IDs are not yet persisted.

## Operator commands

```bash
ncl providers list
ncl providers profiles

ncl providers create-openai-compatible \
  --name local-models \
  --base-url https://models.example.com/v1 \
  --api-family chat-completions \
  --model example-model \
  --auth-mode onecli-secret \
  --auth-ref ExampleModels

ncl groups config update --id <group-id> --provider-profile local-models
ncl providers verify --id local-models --agent-group-id <group-id>
ncl groups restart --id <group-id>
```

The profile stores only a secret name/reference. The real credential stays in OneCLI. For an unauthenticated local endpoint, use `--auth-mode none`; HTTP requires the explicit `--allow-insecure-http` flag.
Generic providers must be selected through `--provider-profile`; selecting `openai-compatible` as a bare legacy provider is rejected because it has no endpoint or model configuration.

## Resolution and state

Runtime selection order is:

1. session provider profile
2. group provider profile
3. legacy session provider
4. legacy group provider
5. Claude

The host writes a per-session `container.runtime.json` and mounts it at
`/workspace/agent/container.json` and the compatibility path
`/workspace/group/container.json`. The group-level
`groups/<folder>/container.json` remains an operator snapshot and never
carries a session override.

Continuation and transcript state is scoped by profile plus a non-secret endpoint/model fingerprint. Two profiles using the same adapter cannot read each other's state. The generic adapter stores a bounded normalized transcript in the container-owned `outbound.db` so stateless endpoints retain context across container restarts.

For default-off orchestration fallback evaluation, the generic protocol loop
also reports whether a terminal failure occurred before any protocol tool call
was entered. Missing or unknown state is never interpreted as pre-tool.
Authentication, quota, invalid-request, native-harness continuation, and
capability/tool-contract mismatches remain ineligible.

When an explicitly evaluated fallback policy is enabled in code, every named
candidate is resolved again through the normal provider/runtime and
`SessionRuntimePlan` path. Dispatch re-runs provider verification through the
real credential route and compares hashes of the concrete registered protocol
tool schemas, not only binding names. An approved candidate executes in a
dedicated session carrying that provider-profile override. The shipped active
policy has no candidate profiles and keeps fallback disabled.

## Capability compilation

Before spawn, the host compiles a session runtime plan from code-owned capability manifests, the selected runtime descriptor, policy, and deterministic local availability checks. The built-ins cover message delivery, scheduling, durable jobs and agent tasks, agent management, self-modification, CLI dispatch, browser access, configured external MCP access, workspace editing, and the bounded RTK-backed `runtime.shell` capability.

Required capability loss throws before container materialization. Explicitly optional loss is recorded as rejected instead. Claude and Codex receive the compiled plan in runtime JSON; their NanoClaw MCP subprocess filters tool discovery and calls by capability ID, and configured external servers are attached only with the compiled external-MCP grant. The `openai-protocol-loop` runtime always receives an empty `mcpServers` map; verified tools are supplied only through compiled `protocol-tool` bindings.

`runtime.shell` resolves through the built-in NanoClaw MCP server only for
`claude-sdk` and `codex-app-server`. It is explicitly optional in the default
profile so generic protocol profiles record it as unavailable instead of
failing startup. It has no `protocol-tool` adapter: verifying generic function
calling must never grant arbitrary shell execution.

For every resolved runtime, the compiled `SessionRuntimePlan` is embedded in the existing per-session runtime JSON. Native runners expose only capability-granted MCP tools; verified generic runners expose only code-owned NanoClaw tools named by protocol bindings in that plan. Selected manifested skills contribute required capabilities before compilation; unapproved, drifted, incompatible, or unsatisfied skills fail before spawn. Manifest-less skills remain instruction-only during rollout.

A configured skill that is no longer installed is omitted from the effective
session plan and logged at container wake instead of blocking the entire
runtime. This does not weaken manifested-skill checks: an installed skill that
is invalid, unapproved, drifted, runtime-incompatible, or missing a required
capability/configuration/secret still fails closed before spawn.

Canonical NanoClaw tool definitions are also the audit boundary for native MCP
and protocol-loop execution. The runner emits redacted lifecycle records
through `outbound.db`; the host validates the declared capability/version and
source session before writing the central append-only audit table. Audit
records contain a hash of non-sensitive validated arguments, never raw model
or tool payloads.

For orchestration-scoped direct turns, terminal provider outcome and normalized
usage are returned through a separate redacted system action. If one provider
turn consumes several queued orchestration messages, usage is persisted once
with explicit shared-batch attribution; it is not copied into every run.
Active step capability requirements are passed into the same pre-spawn
`SessionRuntimePlan` compiler used by ordinary provider selection.
The compiled capability IDs are persisted as a session authorization snapshot;
non-internal host actions fail closed when absent from that snapshot or when no
code-owned manifest maps the action. Correlated actions also require an active
run.

## Generic endpoint limitations

The generic adapter supports Responses and Chat Completions streaming text. It:

- sends bounded provider-neutral instructions with every request;
- queues follow-ups and acknowledges them only after their result;
- classifies auth, quota, rate-limit, context, transient, and invalid-request failures;
- stays text-only until `ncl providers verify-tools --id <profile> [--agent-group-id <group>]` proves function calling through the real credential path;
- on verified profiles, executes only compiled canonical tools with strict argument validation, sequential execution, per-turn duplicate-call suppression, at most eight calls per iteration, at most eight iterations, and 64 KiB bounded tool results;
- reports media as unsupported.

Tool verification is fingerprinted to provider, protocol, endpoint, API family, and model. Any mismatch fails closed to text-only. Generic function calling is not MCP support: arbitrary external MCP discovery remains unavailable.

To roll back immediately, set the profile tool strategy to `none` and restart assigned groups. Do not retain `native` while removing runner broker code.

## Durable cross-agent tasks

Durable task contracts are provider-neutral. Claude, Codex, and a probe-verified generic profile use the same canonical task tools and central event lifecycle. The assignee always executes with its own runtime/model/profile and security policy; provider preference in the envelope cannot override compatibility or grant capabilities. Unverified generic profiles remain unable to invoke protocol tools.

## Auxiliary roles and usage

Auxiliary roles are explicit per-agent routes to `main`, an enabled endpoint
profile, an authorized agent destination, or `disabled` (the default).
Resolution uses the normal runtime/profile registries and compiles an empty
capability set with disabled CLI and a read-only workspace. The durable
invocation service records normalized terminal results and optional token
usage; execution adapters remain responsible for using the existing
container/OneCLI path.

Provider result events may report input, output, and cached token counts.
Missing values remain absent, and NanoClaw does not invent exact counts or
prices. Current cost fields are reserved for explicitly marked estimates.

`memory.session-search` is a canonical, side-effect-free capability. Claude and
Codex receive it through the NanoClaw MCP server; verified generic profiles
receive its compiled protocol-tool binding. The host derives agent scope and
returns only bounded, source-attributed, untrusted excerpts.

Enabled neutral OKF memory uses an explicit provider delivery contract:

| Runtime           | Delivery boundary                                              | Deliberately excluded            |
| ----------------- | -------------------------------------------------------------- | -------------------------------- |
| Claude            | New-session system append plus SDK `SessionStart`/compact hook | resume                           |
| Codex             | app-server `thread/start`, including stale-thread replacement  | successful resume                |
| OpenAI-compatible | once per logical request                                       | retry and tool-loop re-rendering |

The runner owns rendering and passes only a callback to adapters. Provider
project-document composition consumes the same materialized session profile:
enabled Claude sessions replace the legacy `CLAUDE.local.md` memory appendix
with instructions that reserve that file for standing policy and designate
`memory/` as the durable fact authority. Disabled sessions retain legacy
behavior. Provider creation fails closed when memory is enabled and an adapter
has not declared a
supported delivery mode. Rendered memory is context, not transcript state.

## Installing a native provider

An `/add-<provider>` skill must install and guard:

1. the container `AgentProvider` and container barrel import;
2. a provider descriptor and descriptor barrel import;
3. a derived runtime descriptor and runtime descriptor barrel import;
4. an optional host contribution and host barrel import;
5. pinned runtime dependencies;
6. auth/setup verification where required;
7. result, error, continuation, follow-up, and capability-matrix tests;
8. safe removal instructions that refuse to remove an in-use provider.

An OpenAI-compatible brand normally needs only a profile, not copied TypeScript provider code. A private/custom API needs request/response and error fixtures, unattended authentication details, and explicit continuation/model semantics before a native adapter can be implemented.
