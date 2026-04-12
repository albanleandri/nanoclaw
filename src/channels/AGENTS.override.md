# Channels Override

- This directory contains channel transport integrations and channel registration glue.
- Before editing a channel implementation, inspect `src/index.ts`, `src/channels/registry.ts`, and the specific channel file you are changing.
- When editing Telegram behavior, keep the current Telegram-agent architecture and runtime flow intact; do not propose or introduce orchestration changes away from the Anthropic Agent SDK stack.
- Prefer self-registration and existing `Channel` interface patterns over ad hoc startup wiring.
- Do not imply a channel is part of core if it is actually skill-added or conditional on credentials.
