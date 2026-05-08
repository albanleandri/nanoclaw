# NanoClaw Local Backup

## Overview

NanoClaw automatically backs up its databases and configuration to a local directory. Up to **3 rotating snapshots** are kept. The backup runs nightly at 03:00 UTC by default.

## Where backups are stored

```
~/nanoclaw-backups/
  2026-05-08T03-00-00Z/      ← timestamped snapshot (chmod 700)
    messages.db              ← scheduled tasks, sessions, chat history
    nanoclaw.db              ← app state
    investments.db           ← stock portfolio & screener data
    polymarket_cache.db      ← Polymarket market data
    stock_screener.db        ← screener results
    tips.db                  ← tips data
    available_groups.json    ← group configuration
    current_tasks.json       ← in-progress task state
    tips_config.json         ← tips service config
    backup.log               ← manifest of this snapshot
  latest -> 2026-05-08T03-00-00Z   ← symlink to most recent
```

Credentials (`.env`, container env) are **not** included — recover them from OneCLI Agent Vault after a restore.

The directory is created automatically on first run. To change the location, set `NANOCLAW_BACKUP_DIR` in your environment.

## Running a manual backup

```bash
npm run backup
# or directly:
bash scripts/backup.sh
```

## Setting up automatic backups (cron)

Run `crontab -e` and add:

```
0 3 * * * /bin/bash /home/nanoclaw/nanoclaw/scripts/backup.sh >> ~/nanoclaw-backups/cron.log 2>&1
```

This runs at 03:00 UTC daily. Check the log at `~/nanoclaw-backups/cron.log`.

## What is backed up

| File | Description |
|------|-------------|
| `messages.db` | Core app DB: scheduled tasks, sessions, message log |
| `nanoclaw.db` | NanoClaw app state |
| `investments.db` | Stock portfolio holdings and screener history |
| `polymarket_cache.db` | Polymarket market cache |
| `stock_screener.db` | Screener scan results |
| `tips.db` | Tips service data |
| `available_groups.json` | Group definitions |
| `current_tasks.json` | Active agent task state |
| `tips_config.json` | Tips service configuration |

**Credentials are intentionally excluded.** `.env` and the container environment file contain API keys and bot tokens — these are managed by OneCLI Agent Vault and should be recovered from there after a restore, not from a backup file.

The databases are backed up using the [better-sqlite3 online backup API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#backupdestination-options---promise), which is safe to run while the service is live.

## Restore procedure

### Step 1 — List available backups

```bash
bash scripts/restore.sh --list
```

### Step 2 — Restore

```bash
# Restore the most recent backup (interactive confirmation)
bash scripts/restore.sh --backup latest

# Restore a specific snapshot
bash scripts/restore.sh --backup 2026-05-08T03-00-00Z

# Skip the confirmation prompt
bash scripts/restore.sh --backup latest --yes
```

The restore script will:
1. Stop the NanoClaw service
2. Snapshot the current state to `~/nanoclaw-backups/pre-restore-<timestamp>/` (safety net)
3. Overwrite all backed-up files from the chosen snapshot
4. Restart the service

The pre-restore snapshot is kept so you can undo a bad restore by running restore again pointing to it.

### Step 3 — Re-inject credentials

Credentials were not included in the backup. After restore, ensure OneCLI Agent Vault is available and re-inject secrets if needed:

```bash
onecli --help
```

### Step 4 — Verify

Confirm the service is healthy:

```bash
npm run service:status
```

## Rotation policy

The 3 most recent timestamped directories are kept. Older ones are deleted automatically at the end of each backup run.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NANOCLAW_BACKUP_DIR` | `~/nanoclaw-backups` | Where backups are written |

## Security note

Backup directories are created with `chmod 700` and files with `chmod 600`. Credentials are excluded from backups by design — recover them from OneCLI Agent Vault after a restore.
