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
  nanoclaw_systemd_duplicate_warning "$REPO_ROOT" "$UNIT" || true
  if systemctl --user status "$UNIT"; then
    exit 0
  fi
fi

if command -v launchctl >/dev/null 2>&1; then
  launchctl list | grep nanoclaw
  exit $?
fi

if [ -f "$REPO_ROOT/nanoclaw.pid" ]; then
  PID="$(cat "$REPO_ROOT/nanoclaw.pid" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "nanoclaw running via start-nanoclaw.sh (PID $PID)"
    exit 0
  fi
fi

echo "nanoclaw service not detected"
exit 1
