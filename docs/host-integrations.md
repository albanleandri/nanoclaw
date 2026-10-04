# Host integrations

Host integrations are a narrow trusted-host path for bespoke services whose
authentication cannot use OneCLI's request-injection model. OneCLI remains the
default credential plane for supported OAuth, header, and query-parameter
authentication. A host integration does not expose generic HTTP, commands, or
raw credentials to an agent.

The first production adapter, `family-agenda@1`, is code-registered,
administered through the host-only management surface, and exposed to agents
only through the existing typed family-agenda facade. Merely registering
the adapter cannot invoke it: an enabled profile, a safe credential, and an
exact operation grant are required.

## Trust and storage

The NanoClaw host process and the Unix account running it can read local-file
integration credentials. Agent containers cannot. The local backend stores
credentials outside database backups under `data/private-integrations/v1/`
with owner-only directory and file permissions, generated references, safe
file checks, and staged atomic replacement. This is plaintext at rest unless
the host disk is encrypted; it does not protect against root or compromise of
the NanoClaw host account.

Profile configuration and grants live in the central database, but protected
payloads and their opaque storage references are never returned by CLI status
commands. Profile labels and configuration must therefore contain no names,
account identifiers, usernames, passwords, tokens, cookies, or other private
selectors.

## Host-only management

The `integrations` resource is rejected for every agent caller, including an
agent with global CLI scope. Its operations are not eligible for approval and
are available only over the owner-only host Unix socket.

Typical profile operations are:

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

Profiles start disabled. Updates, enablement, disablement, and credential
revocation use the displayed profile `version` to prevent silent concurrent
overwrites. Enablement requires an available credential that passes the exact
registered adapter's protected-payload validator.

`ncl integrations test <profile>` rechecks filesystem safety and the
protected-payload schema only and reports `upstream_checked: false`. The
generic management test deliberately remains network-free.

`list` and `get` expose profile metadata, non-secret configuration, and a
credential status of `available`, `missing`, `unsafe`, or `unsupported`. They
never return the opaque credential reference or any protected value.

## Internal invocation boundary

The profile-gated host invoker is the only normal runtime path allowed to
resolve an integration credential for execution. It checks an agent's exact
profile/group/operation grant before returning distinguishable profile errors
or accessing the adapter, credential store, network operation, or audit log.
Host callers bypass grants but use the same validation, deadline, output, and
audit path.

Each profile permits one active invocation. A bounded in-memory queue shares
the registered operation's total deadline; a full or expired queue returns the
stable `busy` class. Credentials are safety-checked, reread, and revalidated
for every invocation. Once an invocation audit starts, success, adapter
failure, invalid output, timeout, and caller cancellation all attempt a
terminal metadata-only audit update before the profile slot is released.

Successful output is projected through the adapter's validator, checked
against its normalized-output byte limit, converted to inert JSON data, and
wrapped with observation time, profile identity, adapter version, and
operation name. Raw adapter/upstream errors are replaced with fixed messages
and stable result classes; inputs, outputs, configuration, credentials, and
credential references are not written to the invocation audit.

## Family-agenda adapter

`family-agenda@1` exposes only the read-only `agenda.read` operation. Its
database-safe configuration contains the reviewed tenant slug. The portal
username and person selector are private protected fields and the password is
a secret protected field; none belong in profile configuration or backups.

The adapter permits only HTTPS requests to
`https://www.espace-citoyens.net` and a small code-owned set of tenant portal,
login, account, person-detail, and calendar paths. Redirects are manual and
checked at every hop. Authentication POSTs are never retried; an idempotent GET
may be retried once after a connection failure or HTTP 502/503/504 within the
same invocation deadline. Each request has its own timeout in addition to the
whole-operation deadline.

Headers, cookies, response bodies, cookie count, redirect count, normalized
event count, text fields, and normalized output are bounded. Response bodies
are streamed only up to the limit. HTML/JSON content types and the documented
calendar collections are required before an empty agenda is accepted. Login
fallbacks, authentication rejection, schema drift, oversized data, and
timeouts become stable safe failure classes. Mutation/action URLs and unknown
upstream fields are discarded during normalization.

The typed CLI facade invokes the fixed profile and operation through the normal
authorization, credential, audit, deadline, and output boundary. The completed
supervised migration was followed by a successful observation interval and
explicit operator confirmation. The temporary migrator, legacy client/loader,
rollback switch, and combined legacy credential file have been removed.

## Family-agenda facade verification

`ncl family-agenda show` keeps its existing `--from` and `--days` arguments and
normalized event fields. JSON mode now preserves the host invocation envelope:
the response frame's `data` contains `observed_at`, profile identity, exact
adapter version, operation name, and a nested `data` object containing `from`,
`through`, and `events`. Human rendering continues to show only the agenda.
It produces a deterministic Telegram-friendly view: short windows include
empty weekdays, longer windows group identical daily schedules by week,
distinct bookings remain distinct, and a common location is printed once.
Unknown event text is rendered literally, and missing structured times are not
mislabelled as all-day events. The private family-agenda skill relays this
host-rendered view once without adding inferences; it does not contain a
profile or credential identifier.

After a build and restart, run:

```text
pnpm run verify:family-agenda-cutover
```

The verifier exercises the facade as the exactly granted agent group, checks a
different group receives the non-enumerating authorization denial, confirms a
terminal metadata-only audit, and emits only status, date window, event count,
normalized field names, and observation time. It never prints event values,
group/profile identifiers, configuration, credential references, or protected
payloads. It is a live read-only operation, not a credential migration command.

## Safe credential entry

Never put a credential in a command-line flag, shell variable expansion,
profile config, or an `echo` command. Interactive entry obtains the adapter's
field schema from the host and reads every protected field from the controlling
TTY with echo disabled:

```text
ncl integrations credential set <profile>
ncl integrations credential rotate <profile>
```

For non-interactive automation, the same commands read exactly one bounded
JSON object from stdin. Feed stdin directly from a protected secret source;
do not place the JSON literal in the command line or shell history. Unknown
flags are rejected before input is read.

`set` requires a missing credential. `rotate` requires an existing safe
credential, stages and validates the replacement, and promotes it atomically.
A validation failure leaves the active credential unchanged.

Revocation always disables the profile before deletion:

```text
ncl integrations credential revoke <profile> --expected-version <version>
```

If deletion fails, the profile remains disabled and the command reports that
operator cleanup is required. Ordinary unlinking does not guarantee secure
erasure on journaling or flash storage. The `systemd` value is reserved for
schema compatibility; v1 registers no systemd credential reader or writer.
Such a profile reports `unsupported` and cannot be enabled or invoked.

## Restore behavior

Normal NanoClaw backups include profile configuration, grants, and
metadata-only invocation records, but exclude credentials. After a restore,
an absent local credential is reported as `missing` and invocation fails
closed. Because the restored database can retain `enabled=true`, inspect all
profiles and disable any enabled profile with its displayed version before
entering a replacement credential. Then run the local test and re-enable it
with the new displayed version:

```text
ncl integrations list
ncl integrations disable <profile> --expected-version <version>
ncl integrations credential set <profile>
ncl integrations test <profile>
ncl integrations enable <profile> --expected-version <new-version>
```

Never copy credentials into a database backup, agent workspace, container
mount, prompt, or skill. See [backup.md](backup.md) for the complete restore
sequence.
