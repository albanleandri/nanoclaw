# Groups Override

- This directory contains per-group memory and template files, not application source code.
- `groups/main/CLAUDE.md` and `groups/global/CLAUDE.md` are templates copied into live group folders at group creation time.
- Live group folders (e.g. `groups/telegram_main/`) are runtime state. Do not edit them to fix bugs — fix the templates or the code that copies them.
- Do not add logic or imports here; this is configuration/memory only.
