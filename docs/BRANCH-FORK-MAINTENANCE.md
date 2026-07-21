# Branch and fork maintenance

This repository follows upstream NanoClaw's registry-branch model while carrying
reviewed fork-specific runtime and operator changes.

## Branch model

- **`upstream/main`** contains the shared engine, channel registry, default
  Claude runtime, and host/container contracts.
- **`upstream/channels`** contains optional channel adapters and their tests.
  Channel installation skills copy selected files into a user's checkout; they
  do not merge the whole branch.
- **`upstream/providers`** contains optional provider implementations. Provider
  installation skills use the same reviewed fetch-and-copy model.
- Legacy channel fork repositories and `skill/*` feature branches belong to the
  older merge-based distribution model. Do not use them as the source for new
  installations or forward-merge work.

Registry branches are maintained by forward-merging upstream `main` into them so
their optional modules continue to build against the current core. Registry
branches are never merged wholesale into a user's checkout or back into main.

## This fork

This flavor intentionally differs from stock upstream:

- `origin` is the fork and `upstream` is `qwibitai/nanoclaw`.
- Telegram is already installed and maintained in this tree. Other optional
  channel adapters still come from the `channels` registry branch.
- The provider-neutral runtime foundation and Codex runtime are already
  installed. Additional optional providers may still come from the `providers`
  registry branch.
- Fork-specific runtime, capability, session-DB, and operator changes must be
  preserved when adopting upstream patches. Review and port patches rather than
  assuming a merge or cherry-pick is safe.

The current installed capabilities and differences from upstream are summarized
in the README's **This Fork vs Upstream** section.

## Installing optional modules

Installation skills fetch a registry branch and copy only their declared files,
for example:

```bash
git fetch upstream channels
git show upstream/channels:src/channels/<adapter>.ts > src/channels/<adapter>.ts
```

Use the relevant `/add-<name>` skill rather than executing that example by hand:
the skill also installs exact dependencies, updates registration, runs focused
tests, and records any setup required by the adapter or provider. Some setup
helpers resolve whether `origin` or `upstream` carries the registry branch so
they also work in ordinary user forks.

## Maintaining registry branches

Registry-branch forward merges are upstream maintainer operations, not normal
fork-update steps:

```bash
git fetch upstream
git checkout -B channels upstream/channels
git merge upstream/main
# resolve conflicts, build, and test
git push upstream HEAD:channels
```

Use the same procedure for `providers`. Only push to upstream when explicitly
authorized to maintain that repository.

Known mechanical conflict areas include:

| File                    | Resolution                                                                     |
| ----------------------- | ------------------------------------------------------------------------------ |
| `package.json`          | Keep main's dependencies plus exact registry-specific dependencies.            |
| `pnpm-lock.yaml`        | Start from main's lockfile, install the registry dependencies, and regenerate. |
| `.env.example`          | Preserve main entries and add only registry-specific variables.                |
| `repo-tokens/badge.svg` | Keep main's generated version.                                                 |

Always build and test after a forward merge. An automatic merge can still be
wrong when an optional module calls a renamed function or relies on a changed
contract.

## Reviewing upstream for this fork

Fetch first, inspect the commits and affected files, then classify each change:

- **Adopt** when the same invariant and code path exist here.
- **Adapt** when the behavior is valuable but this fork has refactored the path
  or has stronger provider-neutral, capability, or session guarantees.
- **Skip** when the component is not installed or the change conflicts with an
  intentional fork difference.

Prefer small ports with focused regressions. After a runtime change, run the
affected host or Bun tests, both relevant typechecks, formatting, lint, and the
full suite in proportion to risk. Update the README if any user-facing claim
changes and record meaningful adoption work in the local handoff.
