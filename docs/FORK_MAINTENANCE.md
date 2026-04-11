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
