# Host-integration plugin architecture

NanoClaw host integrations are a trusted-host exception for reviewed services
whose authentication cannot use OneCLI request injection. Public core code owns
the authorization and execution boundary; service-specific code belongs in a
separate private checkout that is never mounted into agent containers.

## Boundary

Public core provides:

- exact-version adapter, operation, protected-field, and renderer contracts;
- profile grants, credential storage, metadata-only audit, concurrency, and
  whole-operation deadlines;
- a bounded HTTP session runtime for exact HTTPS origins, methods, paths,
  queries, redirects, headers, cookies, response bodies, retries, content
  types, and cancellation;
- a startup loader driven by one owner-controlled manifest; and
- a generic `ncl integration invoke` resource that is distinct from the
  host-only `ncl integrations` administration surface.

Private plugins provide every service-specific fact: origins, paths,
authentication flow, configuration and protected-payload schemas, input and
output schemas, normalization, presentation, tests, and live verification.
Plugins are trusted host code with the authority of the NanoClaw Unix account.
They are not sandboxed and must receive the same review as host source.

## Startup and invocation

The loader reads only the fixed local startup manifest. Each entry names an
absolute module file and its SHA-256 digest. The loader rejects unsafe file
ownership or modes, symlinks, duplicate entries, digest drift, malformed
plugins, duplicate adapters/renderers, and renderers that do not target an
adapter operation declared by the same plugin. Missing configured plugins are
fatal. Module paths never come from profiles, grants, database fields, agents,
or invocation input.

An agent invocation supplies an adapter ID, exact version, operation, optional
non-secret profile name, and JSON input. The host derives caller identity from
the CLI transport, selects only profiles granted to that caller, preserves the
same denial for nonexistent and unauthorized selections, and then delegates to
the existing invoker. The adapter validates input before credentials are read.
Successful output is schema-validated and byte-bounded before an optional
plugin renderer sees it. The JSON response always remains the normalized
invocation envelope.

## Threat model

The design assumes the host process, its Unix account, the startup manifest,
and installed plugin code are trusted. Agents, containers, invocation JSON,
profile data, upstream responses, redirects, cookies, and network failures are
untrusted.

Controls are deliberately layered:

- agents cannot choose code or module paths;
- grants are checked before distinguishable profile, plugin, credential, or
  network errors;
- plugins cannot obtain a generic credentialed browser primitive: every
  request is checked against their registered exact-origin URL/method policy;
- redirect hops, retryable methods/statuses, per-request and total deadlines,
  headers, origin-scoped cookies, bodies, normalized output, and accepted
  content types are bounded;
- authentication requests are non-retryable unless a reviewed plugin policy
  explicitly permits their method (the initial public contract permits retry
  configuration only for idempotent methods);
- raw credentials, cookies, request bodies, upstream bodies, normalized data,
  and renderer output do not enter invocation audit; and
- plugin checkouts and manifests remain host-only and outside every container
  mount.

This architecture does not protect credentials from root, the NanoClaw Unix
account, or malicious installed plugin code. Services needing that boundary
require a separate least-privilege broker rather than a host plugin.
