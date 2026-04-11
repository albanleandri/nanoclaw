#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

if [ "${1:-}" = "" ]; then
  echo "Usage: bash scripts/setup-step.sh <step> [step args...]" >&2
  exit 1
fi

STEP="$1"
shift

exec npx tsx setup/index.ts --step "$STEP" -- "$@"
