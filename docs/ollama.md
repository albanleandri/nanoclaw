# Using Ollama

Use Ollama through a DB-backed OpenAI-compatible provider profile. Do not
redirect the Claude SDK with `ANTHROPIC_BASE_URL`: that legacy approach keeps
Claude-specific runtime semantics and bypasses the current provider/profile
compiler.

## Prerequisites

- Ollama is running on the host.
- The selected model is already present (`ollama list`).
- Ollama exposes its OpenAI-compatible `/v1` API.
- The caller running `ncl providers create-openai-compatible` has global CLI
  scope.

NanoClaw adds `host.docker.internal:host-gateway` on Linux, so a normal Docker
container can address a host Ollama service by that name. Ensure Ollama is
listening on an interface reachable from Docker; a loopback-only listener may
not be reachable.

Egress lockdown intentionally aliases `host.docker.internal` to the OneCLI
gateway instead of the host. Direct local Ollama access is therefore
incompatible with `NANOCLAW_EGRESS_LOCKDOWN=true` unless you add an explicitly
reviewed gateway/proxy route.

## Create and assign a profile

```bash
ncl providers create-openai-compatible \
  --name ollama-local \
  --base-url http://host.docker.internal:11434/v1 \
  --api-family chat-completions \
  --model <model-from-ollama-list> \
  --auth-mode none \
  --allow-insecure-http

ncl providers verify \
  --id ollama-local \
  --agent-group-id <agent-group-id>

ncl groups config update \
  --id <agent-group-id> \
  --provider-profile ollama-local

ncl groups restart --id <agent-group-id>
```

The explicit insecure-HTTP flag is required because local Ollama normally
uses HTTP. The profile stores endpoint/model configuration in the central DB;
no credential is stored when `auth-mode` is `none`.

## Tool support

New generic profiles are text-only. If the model and Ollama endpoint support
function calling, probe it through the real runtime route:

```bash
ncl providers verify-tools \
  --id ollama-local \
  --agent-group-id <agent-group-id>
```

Successful verification activates only NanoClaw's compiled canonical
protocol-tool bindings. It does not add arbitrary MCP discovery. A failed
probe leaves the profile text-only.

## Troubleshooting

Verify host reachability first:

```bash
curl http://127.0.0.1:11434/v1/models
```

Then inspect the profile and the runner:

```bash
ncl providers profiles
ncl providers verify --id ollama-local --agent-group-id <agent-group-id>
docker logs --tail 200 <nanoclaw-container-name>
```

Common causes:

- Ollama listens only on host loopback and Docker cannot reach it.
- The model name differs from `ollama list`.
- The model does not support the requested function-calling behavior.
- Egress lockdown redirects the host-gateway name to OneCLI.

## Rollback

Assign a different provider/profile to the group and restart it. Do not edit
generated `groups/<folder>/container.json`; it is derived from central
configuration and will be regenerated.
