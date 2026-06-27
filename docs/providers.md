# Provider descriptors and profiles

NanoClaw separates installed provider code from local endpoint configuration:

- A **provider descriptor** states which runtime is installed, its auth/model metadata, and its actual capabilities.
- A **provider profile** selects a descriptor and adds local settings such as endpoint, API family, model, and a OneCLI secret reference.
- A **container provider** executes turns inside the Bun agent-runner.
- An optional **host contribution** supplies provider-specific mounts or environment.

Claude remains the default. Codex remains a native app-server provider. `openai-compatible` is a generic, text-only endpoint adapter; it is not the Codex runtime.

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

## Generic endpoint limitations

The initial generic adapter supports Responses and Chat Completions streaming text. It:

- sends bounded provider-neutral instructions with every request;
- queues follow-ups and acknowledges them only after their result;
- classifies auth, quota, rate-limit, context, transient, and invalid-request failures;
- does not expose MCP or function calling;
- reports media as unsupported.

Switching a tool-dependent group to this adapter is a capability downgrade. Do not describe generic function calling as MCP support.

## Installing a native provider

An `/add-<provider>` skill must install and guard:

1. the container `AgentProvider` and container barrel import;
2. a provider descriptor and descriptor barrel import;
3. an optional host contribution and host barrel import;
4. pinned runtime dependencies;
5. auth/setup verification where required;
6. result, error, continuation, and follow-up tests;
7. safe removal instructions that refuse to remove an in-use provider.

An OpenAI-compatible brand normally needs only a profile, not copied TypeScript provider code. A private/custom API needs request/response and error fixtures, unattended authentication details, and explicit continuation/model semantics before a native adapter can be implemented.
