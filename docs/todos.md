# Shared Todo management

NanoClaw has one canonical personal Todo list shared across providers. Its
human-readable backing file is `groups/shared/knowledge/TODO.md`, and the Node
host is its only writer.

## Authority

- Agents granted the shared `knowledge` resource are equal Todo clients,
  regardless of whether they run Claude, Codex, OpenCode/Lumo, or another
  tool-capable provider.
- Every read or mutation goes through `ncl todos`. Agents must not read or edit
  a workspace `TODO.md` directly.
- `ncl tasks` manages scheduled agent work. Provider-native TodoWrite/planning
  tools manage temporary turn plans. Neither is the shared personal Todo list.
- The canonical file is overlaid read-only inside every agent container,
  including the reconciled owner of the surrounding knowledge resource. The
  host serializes mutations and replaces the Markdown file atomically.

## Commands

```bash
ncl todos list
ncl todos add --text "Call the dentist" --due 2026-10-01
ncl todos update --match "dentist" --text "Call the stomatologist"
ncl todos update --match "stomatologist" --due none
ncl todos complete --match "stomatologist"
ncl todos remove --match "stomatologist"
```

`--match` is a case-insensitive unique substring of an active item. Ambiguous
or missing matches fail without changing the list. Deadlines use `YYYY-MM-DD`;
`--due none` clears one. Duplicate active item text, multiline text, malformed
dates, and unsafe canonical-file types are rejected.

## Grant and activation

Todo access requires both a non-disabled CLI scope and `knowledge` in the
agent group's `shared_resources`. Configuration is materialized when a session
container starts. After changing a running group, restart it; a stopped group
will pick up the change on its next wake.

Provider-native project documents are composed from the same resource
instruction, so every provider receives the same command and authority rules.
