# Handoff

Use `docs/HANDOFF.local.md` for detailed local notes when available.

## Current objective
- Keep the public fork generic and upstream-friendly while preserving a private personalization layer.

## Shared conventions
- Keep the Telegram runtime on the Anthropic Agent SDK.
- Prefer repo scripts and `package.json` commands over ad hoc operational commands.
- Keep private or domain-specific notes out of the tracked repo when possible.

## Open issues / next steps
- Review tracked docs and examples periodically for local-environment traces or personalization leakage.
- Keep private container skills and other sensitive customization layers outside the public repo surface.
