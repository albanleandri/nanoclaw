#!/usr/bin/env bash
# Reads the current OAuth token from Claude's credentials.json and updates
# the OneCLI vault secret so containers can authenticate. The NanoClaw host
# now performs this reconciliation every five minutes; this script/timer is a
# defense-in-depth and manual recovery path.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

pnpm exec tsx scripts/run-refresh-onecli-token.ts
