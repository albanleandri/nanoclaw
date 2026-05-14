#!/bin/bash
# NanoClaw backup restore utility.
#
# Usage:
#   bash scripts/restore.sh --list              List available backups
#   bash scripts/restore.sh --backup <name>     Restore a specific backup (requires --yes)
#   bash scripts/restore.sh --backup latest     Restore the most recent backup
#
# Flags:
#   --yes     Skip the confirmation prompt
#
# The service is stopped before restore and restarted afterwards.
# The current store/ files are snapshotted to <backup_root>/pre-restore-<timestamp>/
# before anything is overwritten.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_ROOT="${NANOCLAW_BACKUP_DIR:-$HOME/nanoclaw-backups}"

log()  { echo "[restore] $*"; }
die()  { echo "[restore] ERROR: $*" >&2; exit 1; }

BACKUP_NAME=""
YES=false
LIST=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list)   LIST=true; shift ;;
    --backup) BACKUP_NAME="${2:-}"; shift 2 ;;
    --yes)    YES=true; shift ;;
    *) die "Unknown argument: $1" ;;
  esac
done

# --- List mode ---

if $LIST; then
  log "Available backups in $BACKUP_ROOT:"
  find "$BACKUP_ROOT" -maxdepth 1 -mindepth 1 -type d | sort | while read -r d; do
    label="$(basename "$d")"
    log_file="$d/backup.log"
    if [ -f "$log_file" ]; then
      ts=$(grep "^timestamp=" "$log_file" | cut -d= -f2)
      echo "  $label  (timestamp: $ts)"
    else
      echo "  $label"
    fi
  done
  exit 0
fi

# --- Resolve backup path ---

[ -z "$BACKUP_NAME" ] && die "Specify --backup <name> or --backup latest. Use --list to see options."

if [ "$BACKUP_NAME" = "latest" ]; then
  [ -L "$BACKUP_ROOT/latest" ] || die "'latest' symlink not found in $BACKUP_ROOT"
  BACKUP_NAME="$(readlink "$BACKUP_ROOT/latest")"
fi

BACKUP_DIR="$BACKUP_ROOT/$BACKUP_NAME"
[ -d "$BACKUP_DIR" ] || die "Backup not found: $BACKUP_DIR"

log "Backup to restore: $BACKUP_NAME"
log "Contents:"
ls -lh "$BACKUP_DIR"

# --- Confirmation ---

if ! $YES; then
  echo ""
  echo "  This will:"
  echo "  1. Stop the NanoClaw service"
  echo "  2. Snapshot current store/ to $BACKUP_ROOT/pre-restore-<now>/"
  echo "  3. Overwrite databases and config files from $BACKUP_NAME"
  echo "  4. Restart the service"
  echo ""
  read -r -p "Continue? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { log "Aborted."; exit 0; }
fi

# --- Stop service ---

log "Stopping NanoClaw service..."
npm --prefix "$PROJECT_ROOT" run service:stop 2>/dev/null || {
  log "service:stop not available — trying systemctl"
  systemctl stop nanoclaw 2>/dev/null || log "WARNING: could not stop service; proceed carefully"
}

# --- Pre-restore snapshot ---

PRE_SNAP="$BACKUP_ROOT/pre-restore-$(date -u +%Y-%m-%dT%H-%M-%SZ)"
log "Snapshotting current state → $PRE_SNAP"
mkdir -p "$PRE_SNAP"
chmod 700 "$PRE_SNAP"
for db in \
  "$PROJECT_ROOT/store/messages.db" \
  "$PROJECT_ROOT/store/nanoclaw.db" \
  "$PROJECT_ROOT/data/nanoclaw.db"; do
  [ -f "$db" ] && cp "$db" "$PRE_SNAP/" && log "snapped: $(basename "$db")"
done
cp "$PROJECT_ROOT/.env" "$PRE_SNAP/env" 2>/dev/null || true
chmod 600 "$PRE_SNAP"/* 2>/dev/null || true

# --- Restore databases ---

restore_db() {
  local src="$BACKUP_DIR/$1" dst="$2"
  if [ -f "$src" ]; then
    cp "$src" "$dst"
    log "restored: $1 → $dst"
  else
    log "SKIP: $1 (not in backup)"
  fi
}

restore_db "messages.db"  "$PROJECT_ROOT/store/messages.db"
restore_db "nanoclaw.db"  "$PROJECT_ROOT/store/nanoclaw.db"
restore_db "nanoclaw.db"  "$PROJECT_ROOT/data/nanoclaw.db"
restore_db "investments.db"        "$PROJECT_ROOT/groups/telegram_main/investments.db"
restore_db "polymarket_cache.db"   "$PROJECT_ROOT/groups/telegram_main/polymarket_cache.db"
restore_db "stock_screener.db"     "$PROJECT_ROOT/groups/main/stock_screener.db"
restore_db "tips.db"               "$PROJECT_ROOT/groups/telegram_main/tips/tips.db"

# --- Restore config files ---

restore_file() {
  local src="$BACKUP_DIR/$1" dst="$2"
  if [ -f "$src" ]; then
    cp "$src" "$dst"
    log "restored: $1 → $dst"
  else
    log "SKIP: $1 (not in backup)"
  fi
}

restore_file "available_groups.json" "$PROJECT_ROOT/data/ipc/telegram_main/available_groups.json"
restore_file "current_tasks.json"  "$PROJECT_ROOT/data/ipc/telegram_main/current_tasks.json"
restore_file "tips_config.json"    "$PROJECT_ROOT/groups/telegram_main/tips/config.json"

# --- Restart service ---

log "Restarting NanoClaw service..."
npm --prefix "$PROJECT_ROOT" run service:restart
log "Done. Service restarted."
log "Pre-restore snapshot kept at: $PRE_SNAP"
