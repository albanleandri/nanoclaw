#!/bin/bash
# NanoClaw local backup — 3 rotating timestamped snapshots.
#
# Run automatically via cron (see docs/backup.md for setup).
# Manual: bash scripts/backup.sh
#
# What is backed up:
#   - All SQLite databases (hot-backup via Node, safe while the service is live)
#   - .env and container env file
#   - JSON state files (available_groups, current_tasks)
#   - Tips config
#
# Backup location (override with NANOCLAW_BACKUP_DIR):
#   ~/nanoclaw-backups/
#     <timestamp>/   (chmod 700 — contains credentials)
#     latest         (symlink to most recent)
#
# Up to 3 backups are kept. The oldest is removed automatically.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

BACKUP_ROOT="${NANOCLAW_BACKUP_DIR:-$HOME/nanoclaw-backups}"
KEEP=3

TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
DEST="$BACKUP_ROOT/$TIMESTAMP"

log() { echo "[backup] $*"; }
log "Starting backup → $DEST"

mkdir -p "$DEST"
chmod 700 "$DEST"

# --- SQLite databases (online backup, safe while live) ---

DATABASES=(
  "$PROJECT_ROOT/store/messages.db"
  "$PROJECT_ROOT/store/nanoclaw.db"
  "$PROJECT_ROOT/data/nanoclaw.db"
  "$PROJECT_ROOT/groups/telegram_main/investments.db"
  "$PROJECT_ROOT/groups/telegram_main/polymarket_cache.db"
  "$PROJECT_ROOT/groups/main/stock_screener.db"
  "$PROJECT_ROOT/groups/telegram_main/tips/tips.db"
)

node "$SCRIPT_DIR/backup-dbs.mjs" --dest "$DEST" "${DATABASES[@]}"

# --- Config and state files ---

copy_if_exists() {
  local src="$1" dst_name="$2"
  if [ -f "$src" ]; then
    cp "$src" "$DEST/$dst_name"
    log "copied: $dst_name"
  else
    log "SKIP: $dst_name (not found)"
  fi
}

copy_if_exists "$PROJECT_ROOT/.env"                                              "env"
copy_if_exists "$PROJECT_ROOT/data/env/env"                                     "container-env"
copy_if_exists "$PROJECT_ROOT/data/ipc/telegram_main/available_groups.json"     "available_groups.json"
copy_if_exists "$PROJECT_ROOT/data/ipc/telegram_main/current_tasks.json"        "current_tasks.json"
copy_if_exists "$PROJECT_ROOT/groups/telegram_main/tips/config.json"            "tips_config.json"

# Write a short manifest
{
  echo "timestamp=$TIMESTAMP"
  echo "project_root=$PROJECT_ROOT"
  ls -1 "$DEST" | grep -v backup.log
} > "$DEST/backup.log"

# Protect all files (including backup.log)
chmod 600 "$DEST"/* 2>/dev/null || true

# --- Update 'latest' symlink ---

ln -sfn "$TIMESTAMP" "$BACKUP_ROOT/latest"
log "latest → $TIMESTAMP"

# --- Rotate: keep at most KEEP backups ---

mapfile -t ALL_BACKUPS < <(
  find "$BACKUP_ROOT" -maxdepth 1 -mindepth 1 -type d | sort
)

EXCESS=$(( ${#ALL_BACKUPS[@]} - KEEP ))
if [ "$EXCESS" -gt 0 ]; then
  for old in "${ALL_BACKUPS[@]:0:$EXCESS}"; do
    log "rotating out: $(basename "$old")"
    rm -rf "$old"
  done
fi

log "Done. Backups kept: $(find "$BACKUP_ROOT" -maxdepth 1 -mindepth 1 -type d | wc -l)"
