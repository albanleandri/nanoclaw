# Host integrations

Host integrations are a narrow trusted-host path for reviewed services whose
authentication cannot use OneCLI request injection. OneCLI remains the default
credential plane for supported OAuth, header, and query authentication. A host
integration never exposes arbitrary HTTP, module loading, commands, or raw
credentials to an agent.

NanoClaw ships only generic plugin contracts, loader, authorization,
credential storage, audit, invocation, bounded HTTP runtime, administration,
and agent invocation. Service origins, paths, schemas, authentication,
normalization, renderers, tests, and live verification belong in private
host-only plugins. Installed plugins are trusted code running with the host
process's authority; they are not sandboxed. See
[host-integration-plugins.md](host-integration-plugins.md) for the architecture
and threat model.

## Plugin installation

The host reads the fixed ignored manifest at:

```text
data/host-integrations/plugins.json
```

Each entry contains a non-sensitive plugin label, an absolute host module path,
and the module's exact SHA-256 digest. The manifest and module must be regular,
single-link, non-symlink files owned by the NanoClaw Unix user and not writable
by group or others. Missing configured files, unsafe state, digest drift,
malformed declarations, duplicate plugins/adapters/renderers, and invalid
operations stop startup.

Module paths never come from agents, invocation input, profiles, grants, or
database fields. Keep private plugin checkouts outside NanoClaw and every path
mounted into agent containers. Updating a plugin requires review, tests, a new
single-file bundle, an updated digest, and a safe host restart. Rebuild
NanoClaw itself only when the public core changes.

An absent manifest is valid only for installations with no enabled plugin
profiles. Startup rejects an enabled profile whose exact adapter version is
not registered.

## Trust and storage

The host process and its Unix account can read local-file credentials. Agent
containers cannot. The backend stores credentials outside database backups
under `data/private-integrations/v1/` with owner-only permissions, generated
references, safe-file checks, and staged atomic replacement. This is plaintext
at rest unless the host disk is encrypted; it does not protect against root or
compromise of the host account.

Profiles and grants live in the central database, but protected payloads and
opaque storage references are never returned by status commands. Profile
labels and configuration must not contain names, account identifiers,
usernames, passwords, tokens, cookies, or private selectors.

## Host-only administration

The plural `integrations` resource is rejected for every agent caller,
including global-scope agents. It is available only over the owner-only host
Unix socket:

```text
ncl integrations list
ncl integrations get <profile>
ncl integrations grants <profile>
ncl integrations create --name <non-sensitive-label> --adapter <id> \
  --adapter-version <version> --config '<non-secret-json>' \
  --credential-backend local-file
ncl integrations update <profile> --expected-version <version> \
  --config '<non-secret-json>'
ncl integrations grant <profile> --group <agent-group-id> \
  --operation <registered-operation>
ncl integrations revoke-grant <profile> --group <agent-group-id> \
  --operation <registered-operation>
ncl integrations enable <profile> --expected-version <version>
ncl integrations disable <profile> --expected-version <version>
```

Profiles start disabled. Enablement requires an available credential that
passes the exact adapter's protected-payload validator. Updates and state
changes use optimistic versions. `ncl integrations test <profile>` checks
local store safety and schema only and reports `upstream_checked: false`; it
performs no network request.

## Agent invocation

Agents use the separate singular resource:

```text
ncl integration invoke --adapter <id> --adapter-version <version> \
  --operation <operation> --input '<json>'
```

The command accepts no URL, method, headers, credential, module path, or
executable. Caller identity comes from the trusted CLI transport. The host
selects a profile only from exact grants matching the caller, adapter version,
and operation. Exactly one match is automatic; multiple matches require
`--profile <non-sensitive-name>`. Unauthorized and nonexistent selections use
the same non-enumerating failure.

Adapter input validation runs before credential access. JSON mode returns the
versioned normalized invocation envelope. Human mode uses an optional
plugin-owned renderer registered for that exact adapter version and operation;
renderers never change the JSON contract.

## Invocation and network boundary

Each profile permits one active invocation. A bounded queue shares the
operation deadline. Credentials are safety-checked, reread, and revalidated on
every invocation. Success, failure, invalid output, timeout, and cancellation
attempt a terminal metadata-only audit update before the slot is released.

Every plugin operation declares and enforces:

- exact HTTPS origins and ports;
- allowed paths, queries, and methods;
- redirect validation and maximum hops;
- per-request and whole-operation deadlines;
- retryable idempotent methods/statuses, attempts, and `Retry-After` bounds;
- header, cookie, cookie-count, body, and normalized-output limits;
- accepted response content types on every request; and
- strict input, protected-payload, configuration, and output schemas.

The reusable session runtime checks every request and redirect against the
operation declaration, uses manual redirects, keeps a bounded
invocation-local and origin-scoped cookie jar, streams bodies only to the
declared limit, propagates cancellation, and permits retries only under the
declared GET policy. Authentication POSTs are never retried. Plugins project
only the minimum inert data required by their authorized workflow.

Raw errors are replaced with stable messages and classes. Inputs, outputs,
configuration, credentials, references, cookies, query-bearing URLs, and
renderer output are excluded from invocation audit.

## Safe credential entry

Never put a credential in a flag, shell expansion, profile configuration, or
an `echo` command. Interactive entry reads plugin-declared protected fields
from the controlling TTY with echo disabled:

```text
ncl integrations credential set <profile>
ncl integrations credential rotate <profile>
```

Non-interactive automation reads exactly one bounded JSON object from stdin.
`set` requires a missing credential. `rotate` stages and validates before
atomic promotion. Validation failure leaves the active credential unchanged.

Revocation disables before deleting:

```text
ncl integrations credential revoke <profile> --expected-version <version>
```

Deletion failure leaves the profile disabled. Ordinary unlinking does not
guarantee secure erasure. The `systemd` backend is reserved; v1 registers no
reader or writer for it.

## Restore behavior

Backups include profiles, grants, and metadata-only audit, but exclude
credentials and private plugin checkouts. Restore the reviewed plugin and
manifest independently. Then disable any enabled profile whose credential is
absent, enter a replacement safely, run the local test, and re-enable it:

```text
ncl integrations list
ncl integrations disable <profile> --expected-version <version>
ncl integrations credential set <profile>
ncl integrations test <profile>
ncl integrations enable <profile> --expected-version <new-version>
```

Never copy credentials into a backup, plugin repository, agent workspace,
container mount, prompt, or skill. Service-specific verification and rollback
instructions belong in the private plugin repository.
