#!/bin/bash
# Release-acceptance smoke for the provider-neutral `run_shell` MCP tool.
#
# Runs scripts/rtk-shell-container-smoke.ts inside the built agent image with an
# empty writable workspace and this checkout mounted read-only. Exercises the
# real tool catalog, the real capability gate, and real RTK rewriting plus
# process execution — the contract Claude and Codex share. No provider call is
# made, so it needs no credentials and costs nothing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Matches container/build.sh so the smoke targets this install's image.
# shellcheck source=../setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
IMAGE="$(container_image_base):${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

WORKSPACE="$(mktemp -d)"
# The image runs as `node`; the bind-mounted workspace must be traversable by
# that uid or the shell executor cannot spawn in its /workspace/agent cwd.
chmod 777 "$WORKSPACE"
trap 'rm -rf "$WORKSPACE"' EXIT

"$CONTAINER_RUNTIME" run --rm --entrypoint bun \
  -v "$PROJECT_ROOT":/repo:ro \
  -v "$WORKSPACE":/workspace/agent \
  "$IMAGE" \
  /repo/scripts/rtk-shell-container-smoke.ts
