#!/usr/bin/env bash
# Reads the current OAuth token from Claude's credentials.json and updates
# the OneCLI vault secret so containers can authenticate. Run hourly via
# nanoclaw-refresh-token.timer (token expires every ~8 hours).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

pnpm exec tsx scripts/run-refresh-onecli-token.ts
