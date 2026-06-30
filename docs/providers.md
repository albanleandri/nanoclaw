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

The host writes a per-session `container.runtime.json` and mounts it at `/workspace/agent/container.json`. The group-level `groups/<folder>/container.json` remains an operator snapshot and never carries a session override.

Continuation and transcript state is scoped by profile plus a non-secret endpoint/model fingerprint. Two profiles using the same adapter cannot read each other's state. The generic adapter stores a bounded normalized transcript in the container-owned `outbound.db` so stateless endpoints retain context across container restarts.

## Capability compilation

Before spawn, the host compiles a session runtime plan from code-owned capability manifests, the selected runtime descriptor, policy, and deterministic local availability checks. The initial built-ins cover message delivery, task scheduling, browser MCP access, and workspace editing.

Required capability loss throws before container materialization. Explicitly optional loss is recorded as rejected instead. Claude and Codex retain their existing MCP configuration byte-for-byte. The `openai-protocol-loop` runtime always receives an empty `mcpServers` map; verified tools are supplied only through compiled `protocol-tool` bindings.

For a verified generic profile, the compiled `SessionRuntimePlan` is embedded in the existing per-session runtime JSON. The runner exposes only code-owned NanoClaw tools named by that plan. Selected manifested skills contribute required capabilities before compilation; unapproved, drifted, incompatible, or unsatisfied skills fail before spawn. Manifest-less skills remain instruction-only during rollout.

Canonical NanoClaw tool definitions are also the audit boundary for native MCP
and protocol-loop execution. The runner emits redacted lifecycle records
through `outbound.db`; the host validates the declared capability/version and
source session before writing the central append-only audit table. Audit
records contain a hash of non-sensitive validated arguments, never raw model
or tool payloads.

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
