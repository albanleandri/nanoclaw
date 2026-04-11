#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

if command -v systemctl >/dev/null 2>&1; then
  if systemctl --user restart nanoclaw; then
    exit 0
  fi
fi

if command -v launchctl >/dev/null 2>&1; then
  exec launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"
fi

exec bash start-nanoclaw.sh
