# Handoff

Use `docs/HANDOFF.local.md` for detailed local notes when available.

## Current objective
- Keep the public fork generic and upstream-friendly while preserving a private personalization layer.
- Make runtime skill loading group-aware: main control chats keep the full skill set, while new secondary groups default to base skills and explicitly opt into extras.
- Make new group registration enumerate exact runtime tools and skills, so selections can be made by numbered list and stored explicitly per group.

## Shared conventions
- Keep the Telegram runtime on the Anthropic Agent SDK.
- Prefer repo scripts and `package.json` commands over ad hoc operational commands.
- Keep private or domain-specific notes out of the tracked repo when possible.

## Open issues / next steps
- Review tracked docs and examples periodically for local-environment traces or personalization leakage.
- Keep private container skills and other sensitive customization layers outside the public repo surface.
- Consider whether secondary-group registration should gain the same numbered selection UX in non-agent setup paths too, not just through the main chat agent.
