# Fork Maintenance

This fork is structured in three layers:

## Public layer
- Upstream-trackable NanoClaw code
- Generic workflow improvements
- Public-safe collaboration docs and scripts

Keep this layer generic. It should not reveal private use cases, local environment details, or domain-specific personalization.

## Private layer
- Private container skills
- Domain-specific extensions
- Personal prompts, workflows, and other sensitive customization

Personal forks may back `container/skills/` with a private submodule or another private distribution path. The tracked `.gitmodules` entry in the public repo is intentionally a placeholder.

## Runtime skill loading
- Non-main groups default to a base runtime skill set: `agent-browser`, `capabilities`, and `status`.
- Additional runtime skills can be enabled per group with `containerConfig.extraSkills`.
- Main groups keep legacy all-skills behavior by default for backwards compatibility, but can also be moved to `skillMode: "base-plus-extras"` later if you want stricter isolation and lower inference cost.
- If a niche skill is unavailable in one group but present in another, check that group's `containerConfig.skillMode` and `containerConfig.extraSkills` before treating it as a runtime bug.

## Local-only layer
- `.env`
- `data/`, `logs/`, `store/`, `dist/`
- `docs/HANDOFF.local.md`
- Any machine-specific notes or runtime state

These files must remain ignored and untracked.

## Upstream sync guidance
- Pull or merge upstream changes into the public layer first.
- Resolve generic conflicts in the public fork.
- Update the private layer separately when upstream changes require it.
- Avoid mixing public-safe maintenance changes with private domain changes in the same commit.

## Public-safe checklist
- No secrets, tokens, auth files, or runtime databases
- No personal repo URLs in tracked config
- No local timezone, machine path, or group-name traces in tracked docs unless intentionally generic
- No domain-specific private use-case notes in tracked collaboration files
