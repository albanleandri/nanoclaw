# NanoClaw Security Model

## Trust Model

| Entity            | Trust Level | Rationale                        |
| ----------------- | ----------- | -------------------------------- |
| Main group        | Trusted     | Private self-chat, admin control |
| Non-main groups   | Untrusted   | Other users may be malicious     |
| Container agents  | Sandboxed   | Isolated execution environment   |
| Incoming messages | User input  | Potential prompt injection       |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (lightweight Linux VMs), providing:

- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:

- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**

```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**

- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

**Read-Only Project Root:**

The main group's project root is mounted read-only. Writable paths the agent needs (store, group folder, IPC, `.claude/`) are mounted separately. This prevents the agent from modifying host application code (`src/`, `dist/`, `package.json`, etc.) which would bypass the sandbox entirely on next restart. The `store/` directory is mounted read-write so the main agent can access the SQLite database directly.

### 3. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:

- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation                   | Main Group | Non-Main Group |
| --------------------------- | ---------- | -------------- |
| Send message to own chat    | ✓          | ✓              |
| Send message to other chats | ✓          | ✗              |
| Schedule task for self      | ✓          | ✓              |
| Schedule task for others    | ✓          | ✗              |
| View all tasks              | ✓          | Own only       |
| Manage other groups         | ✓          | ✗              |

### 5. Credential Isolation (OneCLI Agent Vault)

Anthropic credentials do not need to enter containers when NanoClaw is configured to use [OneCLI's Agent Vault](https://github.com/onecli/onecli). NanoClaw requests OneCLI gateway config at container startup and routes outbound Anthropic traffic through that gateway.

**How it works:**

1. Credentials are registered once with `onecli secrets create`, stored and managed by OneCLI
2. When `ONECLI_URL` is configured, NanoClaw calls `applyContainerConfig()` before `docker run`
3. The gateway returns proxy env vars and CA mounts, and NanoClaw uses `ANTHROPIC_AUTH_MODE` to choose the SDK placeholder auth flow (`api-key` or `oauth`)
4. The gateway matches requests by host and path, injects the real Anthropic credential, and forwards
5. Agents cannot discover the real Anthropic credential in environment, stdin, files, or `/proc`

**Per-group policy hook:**
NanoClaw requests OneCLI container config using the group folder as the agent identifier. This gives OneCLI a stable per-group hook for policy when configured on the gateway side.

**Explicit exception:**
Variables forwarded with the `CONTAINER_SECRET_*` prefix are still injected directly into the container environment by design. They are an explicit opt-in escape hatch for non-proxied secrets such as calendar URLs, and agents can read them.

**NOT Mounted:**

- Channel auth sessions (`store/auth/`) — host only
- Mount allowlist — external, never mounted
- Any credentials matching blocked patterns
- `.env` is shadowed with `/dev/null` in the project root mount

### 6. Egress Lockdown (Opt-In Forced Proxy)

`HTTPS_PROXY` only affects proxy-aware clients. A tool that ignores proxy env vars
or opens raw sockets can otherwise reach the internet directly and bypass OneCLI
credential injection, policy, and audit.

When `NANOCLAW_EGRESS_LOCKDOWN=true`, NanoClaw puts agent containers on a Docker
internal network with no internet route. The OneCLI gateway container is attached
to that network as `host.docker.internal`, so the gateway is the only reachable
egress hop. If NanoClaw cannot create the network or attach the gateway, it
refuses to spawn the agent rather than falling back to open egress. Host sweep
also re-checks the network so an out-of-band gateway detach can self-heal.

Configuration:

| Env                        | Default           | Meaning                                              |
| -------------------------- | ----------------- | ---------------------------------------------------- |
| `NANOCLAW_EGRESS_LOCKDOWN` | `false`           | Set `true` to force agent egress through OneCLI.     |
| `NANOCLAW_EGRESS_NETWORK`  | `nanoclaw-egress` | Internal Docker network name.                        |
| `ONECLI_GATEWAY_CONTAINER` | `onecli`          | Gateway container to attach to the internal network. |

With lockdown enabled, workflows that rely on non-proxy-aware tools reaching the
internet directly will fail by design. Leave it unset for the existing open
egress behavior.

## Privilege Comparison

| Capability          | Main Group                                                  | Non-Main Group                                              |
| ------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| Project root access | `/workspace/project` (ro)                                   | None                                                        |
| Store (SQLite DB)   | `/workspace/project/store` (rw)                             | None                                                        |
| Group folder        | `/workspace/agent` and legacy alias `/workspace/group` (rw) | `/workspace/agent` and legacy alias `/workspace/group` (rw) |
| Global memory       | Implicit via project                                        | `/workspace/global` (ro)                                    |
| Additional mounts   | Configurable                                                | Read-only unless allowed                                    |
| Network access      | Unrestricted                                                | Unrestricted                                                |
| MCP tools           | All                                                         | All                                                         |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Incoming Messages (potentially malicious)                         │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • OneCLI Agent Vault (injects credentials, enforces policies)   │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only, no secrets
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • API calls routed through OneCLI Agent Vault                   │
│  • No real credentials in environment or filesystem              │
└──────────────────────────────────────────────────────────────────┘
```

## Supply Chain Security (pnpm)

NanoClaw uses pnpm with two supply chain defenses configured in `pnpm-workspace.yaml`:

### Minimum Release Age

`minimumReleaseAge: 4320` (3 days). pnpm will refuse to resolve any package version published less than 3 days ago. This defends against typosquatting and compromised maintainer accounts — most malicious publishes are detected and pulled within 72 hours.

**Excluding a package from the release age gate** (`minimumReleaseAgeExclude`):

This should be rare. When a zero-day fix or critical dependency requires an immediate update:

1. The exclusion must be reviewed and approved by a human maintainer
2. The entry must pin the **exact version** being excluded — never a range or wildcard
   ```yaml
   minimumReleaseAgeExclude:
     some-package: '1.2.3' # Approved by @user, 2026-04-14 — CVE-XXXX-YYYY fix
   ```
3. The exclusion should be removed once the version ages past the threshold (i.e. after 3 days)
4. Automated agents (Claude, CI bots) must never add exclusions without human sign-off

### Build Script Allowlist

`onlyBuiltDependencies` restricts which packages can execute install/postinstall scripts. Only packages on this list are permitted to run build scripts during `pnpm install`. Currently allowed:

- `better-sqlite3` — compiles native SQLite bindings
- `esbuild` — downloads platform-specific binary
- `protobufjs` — generates protobuf bindings (used by Baileys/libsignal)
- `sharp` — downloads platform-specific image processing binary

Adding a package to this list requires human approval — build scripts execute arbitrary code with the installing user's permissions.

### `.npmrc` Safety Net

The `.npmrc` file contains `minReleaseAge=3d` as a fallback. The authoritative setting is in `pnpm-workspace.yaml`, but `.npmrc` provides defense-in-depth if npm is ever invoked directly (e.g. by a tool that doesn't respect pnpm).
