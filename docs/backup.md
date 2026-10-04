# NanoClaw Local Backup

## Overview

NanoClaw backs up its central database and group state to a local directory. Up to **3 rotating snapshots** are kept. The backup is typically run nightly via cron.

## Where backups are stored

```
~/nanoclaw-backups/
  2026-06-20T03-00-00Z/      ← timestamped snapshot (chmod 700)
    v2.db                    ← central DB (users, agent groups, wirings, roles, schedules…)
    *.db                     ← configured per-group SQLite databases
    *.json                   ← configured per-group config/state files
    backup.log               ← manifest of this snapshot
  latest -> 2026-06-20T03-00-00Z   ← symlink to most recent
```

Credentials (`.env`, container env, and `data/private-integrations/`) are
**not** included. Recover supported provider credentials from OneCLI Agent
Vault and reprovision trusted-host integration credentials through their
host-only safe-entry flow after a restore.

The directory is created automatically on first run. To change the location, set `NANOCLAW_BACKUP_DIR` in your environment.

## Running a manual backup

```bash
pnpm run backup
# or directly:
bash scripts/backup.sh
```

## Setting up automatic backups (cron)

Run `crontab -e` and add (adjust the path to your install root):

```
0 3 * * * /bin/bash /path/to/nanoclaw-v2/scripts/backup.sh >> ~/nanoclaw-backups/cron.log 2>&1
```

This runs at 03:00 UTC daily. Check the log at `~/nanoclaw-backups/cron.log`.

## What is backed up

| Item                           | Description                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `data/v2.db`                   | Central DB — the source of truth for persistent state: users, roles, agent groups, messaging groups, wirings, schedules, approvals, and other non-per-session data |
| Configured per-group databases | The explicit database paths listed in `scripts/backup.sh`; missing optional databases are skipped                                                                  |
| Configured per-group state     | The explicit JSON state paths copied by `scripts/backup.sh`; missing optional files are skipped                                                                    |

The per-group file list is explicit rather than discovered automatically. When
adding a new persistent group database or state file, add it to
`scripts/backup.sh` so it is included in future snapshots.

**What is intentionally not backed up:**

- **Per-session databases.** Each session has an `inbound.db` and `outbound.db` under `data/v2-sessions/<agent-group>/<session>/`. These are an ephemeral IO surface between the host and a running container — the central DB is the source of truth for persistent state, so the session DBs are not snapshotted.
- **Credentials.** The owner-only `.env` may contain channel tokens and legacy provider credentials. It is not copied into containers or backups; recover supported credentials from OneCLI Agent Vault after a restore. Trusted-host integration credentials under `data/private-integrations/` are also excluded and must be reprovisioned through the host-only safe-entry flow before a restored profile is enabled.

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
bash scripts/restore.sh --backup 2026-06-20T03-00-00Z

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

The restored central DB may retain `enabled=true` for a trusted-host profile
whose local credential was intentionally not backed up. Invocation fails
closed, but inspect every profile and disable any restored enabled profile
before entering a replacement credential. Use the versions displayed by each
preceding command:

```bash
ncl integrations list
ncl integrations disable <profile> --expected-version <version>
ncl integrations credential set <profile>
ncl integrations test <profile>
ncl integrations enable <profile> --expected-version <new-version>
```

Do not copy a credential into `v2.db`, a backup, an agent workspace, a prompt,
or a skill. See [host-integrations.md](host-integrations.md#restore-behavior).

### Step 4 — Verify

Confirm the service is healthy:

```bash
pnpm run service:status
```

## Rotation policy

The 3 most recent timestamped directories are kept. Older ones are deleted automatically at the end of each backup run.

## Configuration

| Variable              | Default              | Description               |
| --------------------- | -------------------- | ------------------------- |
| `NANOCLAW_BACKUP_DIR` | `~/nanoclaw-backups` | Where backups are written |

## Security note

Backup directories are created with `chmod 700` and files with `chmod 600`.
Credentials are excluded by design: recover supported provider credentials
from OneCLI Agent Vault and use the host-only safe-entry flow for trusted-host
integrations after a restore.
