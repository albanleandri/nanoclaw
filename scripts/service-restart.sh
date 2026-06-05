#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$REPO_ROOT"
export PROJECT_ROOT

cd "$REPO_ROOT"

# shellcheck source=scripts/service-units.sh
source "$REPO_ROOT/scripts/service-units.sh"

if command -v systemctl >/dev/null 2>&1; then
  UNIT="$(nanoclaw_systemd_primary_unit "$REPO_ROOT")"
  nanoclaw_systemd_disable_duplicates "$REPO_ROOT" "$UNIT"
  if systemctl --user restart "$UNIT"; then
    exit 0
  fi
fi

if command -v launchctl >/dev/null 2>&1; then
  exec launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"
fi

exec bash start-nanoclaw.sh
