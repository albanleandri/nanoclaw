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

## Runtime tool and skill loading
- New non-main groups should be configured with explicit `containerConfig.allowedTools` and `containerConfig.enabledSkills` selections.
- Recommended secondary-group defaults remain small: core file/web/task tools plus the base skills `agent-browser`, `capabilities`, and `status`.
- Existing groups without explicit tool or skill lists keep their legacy broader behavior until reconfigured.
- If a capability is unavailable in one group but present in another, check that group's `containerConfig.allowedTools`, `containerConfig.enabledSkills`, `containerConfig.skillMode`, and `containerConfig.extraSkills` before treating it as a runtime bug.

## Upstream merge checklist
- Preserve `containerConfig.allowedTools` and `containerConfig.enabledSkills` in the group config shape and persistence layer.
- Preserve broad default runtime access for existing or main control groups unless intentionally reconfigured.
- Preserve explicit tool and skill selection for new non-main groups.
- Preserve the `list_runtime_capabilities` MCP tool and its numbered exact-selection output.
- If upstream changes runtime tools or MCP tools, update `container/agent-runner/src/runtime-capabilities.ts` and its tests first.
- If upstream changes group-registration guidance, make sure `groups/main/CLAUDE.md` still tells the main agent to enumerate exact numbered tool and skill selections before calling `register_group`.

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
