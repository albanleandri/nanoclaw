#!/bin/bash
# Shared helpers for service-status.sh and service-restart.sh.
# Source after PROJECT_ROOT is set.

# shellcheck source=setup/lib/install-slug.sh
source "${PROJECT_ROOT:-$(pwd)}/setup/lib/install-slug.sh"

_nanoclaw_systemd_show() {
  local unit="$1"
  systemctl --user show --property=LoadState,ActiveState,ExecStart,WorkingDirectory "$unit" 2>/dev/null || return 1
}

_nanoclaw_systemd_show_targets_project() {
  local output="$1"
  local project_root="$2"
  local exec_start working_directory
  exec_start="$(printf '%s\n' "$output" | sed -n 's/^ExecStart=//p')"
  working_directory="$(printf '%s\n' "$output" | sed -n 's/^WorkingDirectory=//p')"
  [[ "$exec_start" == *"$project_root/dist/index.js"* || ( "$working_directory" == "$project_root" && "$exec_start" =~ (^|[[:space:]])dist/index.js([[:space:]]|;|$) ) ]]
}

nanoclaw_systemd_candidate_units() {
  local unit_dir="$HOME/.config/systemd/user"
  local own_slug_unit
  own_slug_unit="$(systemd_unit).service"

  printf '%s\n' 'nanoclaw.service'
  printf '%s\n' "$own_slug_unit"

  if [[ -d "$unit_dir" ]]; then
    find "$unit_dir" -maxdepth 1 -type f -name 'nanoclaw*.service' -printf '%f\n' 2>/dev/null || true
  fi | sort -u
}

nanoclaw_systemd_primary_unit() {
  local project_root="$1"
  local slug_unit output unit
  slug_unit="$(systemd_unit).service"

  for unit in nanoclaw.service "$slug_unit"; do
    output="$(_nanoclaw_systemd_show "$unit")" || continue
    if _nanoclaw_systemd_show_targets_project "$output" "$project_root"; then
      printf '%s\n' "$unit"
      return 0
    fi
  done

  for unit in $(nanoclaw_systemd_candidate_units); do
    output="$(_nanoclaw_systemd_show "$unit")" || continue
    if _nanoclaw_systemd_show_targets_project "$output" "$project_root"; then
      printf '%s\n' "$unit"
      return 0
    fi
  done

  if _nanoclaw_systemd_show nanoclaw.service >/dev/null; then
    printf '%s\n' 'nanoclaw.service'
    return 0
  fi
  printf '%s\n' "$slug_unit"
}

nanoclaw_systemd_duplicate_units() {
  local project_root="$1"
  local primary_unit="$2"
  local unit output

  for unit in $(nanoclaw_systemd_candidate_units); do
    [[ "$unit" == "$primary_unit" ]] && continue
    output="$(_nanoclaw_systemd_show "$unit")" || continue
    if _nanoclaw_systemd_show_targets_project "$output" "$project_root"; then
      printf '%s\n' "$unit"
    fi
  done | sort -u
}

nanoclaw_systemd_duplicate_warning() {
  local project_root="$1"
  local primary_unit="$2"
  local duplicates
  duplicates="$(nanoclaw_systemd_duplicate_units "$project_root" "$primary_unit")"
  [[ -z "$duplicates" ]] && return 0

  while IFS= read -r unit; do
    [[ -z "$unit" ]] && continue
    printf 'WARNING: duplicate NanoClaw systemd unit targets this checkout: %s\n' "$unit" >&2
  done <<< "$duplicates"
}

nanoclaw_systemd_disable_duplicates() {
  local project_root="$1"
  local primary_unit="$2"
  local duplicates unit failed=0
  duplicates="$(nanoclaw_systemd_duplicate_units "$project_root" "$primary_unit")"
  [[ -z "$duplicates" ]] && return 0

  while IFS= read -r unit; do
    [[ -z "$unit" ]] && continue
    printf 'Disabling duplicate NanoClaw systemd unit targeting this checkout: %s\n' "$unit" >&2
    if ! systemctl --user disable --now "$unit"; then
      failed=1
    fi
  done <<< "$duplicates"

  return "$failed"
}
