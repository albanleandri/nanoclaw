#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/service-units.sh
source "$ROOT/scripts/service-units.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    fail "$label: expected [$expected], got [$actual]"
  fi
}

assert_contains() {
  local needle="$1"
  local haystack="$2"
  local label="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    fail "$label: expected output to contain [$needle], got [$haystack]"
  fi
}

show_unit() {
  case "$1" in
    nanoclaw.service)
      printf '%s\n' \
        'LoadState=loaded' \
        'ActiveState=active' \
        'ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /home/nanoclaw/nanoclaw-v2/dist/index.js ; }' \
        'WorkingDirectory=/home/nanoclaw/nanoclaw-v2'
      ;;
    nanoclaw-v2-1e478a5f.service)
      printf '%s\n' \
        'LoadState=loaded' \
        'ActiveState=active' \
        'ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /home/nanoclaw/nanoclaw-v2/dist/index.js ; }' \
        'WorkingDirectory=/home/nanoclaw/nanoclaw-v2'
      ;;
    nanoclaw-v2-other.service)
      printf '%s\n' \
        'LoadState=loaded' \
        'ActiveState=active' \
        'ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /srv/other/dist/index.js ; }' \
        'WorkingDirectory=/srv/other'
      ;;
    nanoclaw-refresh-token.service)
      printf '%s\n' \
        'LoadState=loaded' \
        'ActiveState=inactive' \
        'ExecStart={ path=/home/nanoclaw/nanoclaw-v2/scripts/refresh-onecli-token.sh ; argv[]=/home/nanoclaw/nanoclaw-v2/scripts/refresh-onecli-token.sh ; }' \
        'WorkingDirectory=/home/nanoclaw/nanoclaw-v2'
      ;;
    *) return 1 ;;
  esac
}

TMP_HOME="$(mktemp -d)"
trap 'rm -rf "$TMP_HOME"' EXIT
export HOME="$TMP_HOME"
PROJECT_ROOT="/home/nanoclaw/nanoclaw-v2"
mkdir -p "$HOME/.config/systemd/user"
: > "$HOME/.config/systemd/user/nanoclaw.service"
: > "$HOME/.config/systemd/user/nanoclaw-v2-1e478a5f.service"
: > "$HOME/.config/systemd/user/nanoclaw-v2-other.service"
: > "$HOME/.config/systemd/user/nanoclaw-refresh-token.service"

systemctl() {
  [[ "$1" == "--user" ]] || return 64
  shift
  case "$1" in
    show)
      shift
      while [[ "$1" == --property=* ]]; do shift; done
      show_unit "$1"
      ;;
    *) return 1 ;;
  esac
}

primary="$(nanoclaw_systemd_primary_unit "$PROJECT_ROOT")"
assert_eq 'nanoclaw.service' "$primary" 'legacy canonical primary is preferred when it targets this checkout'

duplicates="$(nanoclaw_systemd_duplicate_units "$PROJECT_ROOT" "$primary")"
assert_eq 'nanoclaw-v2-1e478a5f.service' "$duplicates" 'only same-checkout host peers are duplicates'

status_output="$(nanoclaw_systemd_duplicate_warning "$PROJECT_ROOT" "$primary" 2>&1)"
assert_contains 'WARNING: duplicate NanoClaw systemd unit targets this checkout: nanoclaw-v2-1e478a5f.service' "$status_output" 'status warning names duplicate unit'

printf 'service-units tests passed\n'

SYSTEMCTL_DISABLE_CALLS=()
systemctl() {
  [[ "$1" == "--user" ]] || return 64
  shift
  case "$1" in
    show)
      shift
      while [[ "$1" == --property=* ]]; do shift; done
      show_unit "$1"
      ;;
    disable)
      [[ "$2" == "--now" ]] || return 65
      SYSTEMCTL_DISABLE_CALLS+=("$3")
      ;;
    *) return 1 ;;
  esac
}

nanoclaw_systemd_disable_duplicates "$PROJECT_ROOT" "$primary" >/tmp/nanoclaw-service-units-test.out 2>&1
assert_eq 'nanoclaw-v2-1e478a5f.service' "${SYSTEMCTL_DISABLE_CALLS[*]}" 'restart disables only same-checkout duplicate host unit'

printf 'service-units restart tests passed\n'
