#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

if command -v systemctl >/dev/null 2>&1; then
  if systemctl --user status nanoclaw; then
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
