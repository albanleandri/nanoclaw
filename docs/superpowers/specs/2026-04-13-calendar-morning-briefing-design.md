# Calendar Morning Briefing — Design Spec

**Date:** 2026-04-13
**Status:** Approved, ready for implementation

---

## Overview

Add a daily calendar morning briefing to NanoClaw. Once per day at 7:00 AM, a scheduled task fetches the user's personal Proton Calendar via its secret iCal URL, parses events for the next 2–3 days, and sends a concise summary to the main chat.

Scope is intentionally minimal: one calendar, one daily invocation, no polling, no host-side logic. Everything runs as an existing scheduled task using the existing container + scheduler + IPC pipeline.

---

## Goals

- Surface calendar context proactively each morning without the user having to ask
- Keep the iCal URL confidential — never committed to the repo, never leaked in messages
- Add a reusable, structured mechanism for forwarding per-container secrets from `.env`
- Stay extensible: adding a second calendar, higher-frequency alerts, or pre-meeting briefings later requires no redesign

---

## Non-Goals

- Real-time or sub-hourly calendar polling
- Write access to the calendar
- Local news briefing (descoped, may be a future skill)
- Pre-meeting briefings (future extension)
- Work calendar (future extension)

---

## Architecture

Three components, in dependency order:

```
.env (CONTAINER_SECRET_PROTON_ICAL_URL)
  → buildContainerArgs forwards it as -e flag
    → container agent reads env var
      → WebFetch fetches iCal URL
        → skill parses events for next 2-3 days
          → mcp__nanoclaw__send_message sends briefing
```

No new host-side processes. No new IPC commands. No schema changes. No new dependencies.

---

## Part 1: `CONTAINER_SECRET_*` Forwarding

### Motivation

The native credential proxy handles Anthropic API authentication. It has no mechanism for managing arbitrary per-container secrets like a calendar URL. The `.env` file is already gitignored and is the correct trust boundary for local secrets. However, `.env` is currently shadowed with `/dev/null` inside containers (the file is not accessible), and env vars from `.env` are not forwarded to containers.

This change adds a structured, prefix-based mechanism to forward specific `.env` vars as container environment variables.

### Implementation

**Files:** `src/env.ts` (new helper) and `src/container-runner.ts` (call site)

`readEnvFile` only returns keys from an explicit allowlist — passing `[]` returns nothing. A new `readEnvFileByPrefix` helper is needed in `src/env.ts`:

```typescript
// Returns all key/value pairs from .env whose key starts with prefix.
export function readEnvFileByPrefix(prefix: string): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch {
    return {};
  }
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!key.startsWith(prefix)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
         (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }
  return result;
}
```

Then in `src/container-runner.ts`: add a new import `import { readEnvFileByPrefix } from './env.js';`, and in `buildContainerArgs`, after the existing env var injections:

```typescript
// Forward CONTAINER_SECRET_* vars from .env to the container.
// Explicitly opt-in (prefix required) — no accidental leakage of other .env vars.
// The .env file itself remains shadowed (/dev/null) inside containers.
const containerSecrets = readEnvFileByPrefix('CONTAINER_SECRET_');
for (const [key, value] of Object.entries(containerSecrets)) {
  args.push('-e', `${key}=${value}`);
}
```

### Security properties

- Only vars with the `CONTAINER_SECRET_` prefix are forwarded — no accidental leakage of other `.env` vars
- The `.env` *file* remains shadowed with `/dev/null` inside containers — agents cannot enumerate what else is in `.env`
- Forwarded vars are visible to the Claude agent as environment variables. Skills must explicitly instruct Claude not to include these values in outbound messages
- `.env` is gitignored — the secret never enters the repo

### `.env.example` addition

```bash
# Proton Calendar iCal URL (secret — keep out of version control)
# Obtain from: Proton Calendar → Settings → Your calendars → [calendar] → Copy link
# CONTAINER_SECRET_PROTON_ICAL_URL=https://calendar.proton.me/api/calendar/v1/...
```

---

## Part 2: `calendar-morning` Container Skill

### File

`container/skills/calendar-morning/SKILL.md`

### What the skill does

1. Reads `CONTAINER_SECRET_PROTON_ICAL_URL` from the environment via Bash (`echo $CONTAINER_SECRET_PROTON_ICAL_URL`)
2. Fetches the iCal content via `WebFetch`
3. Parses `VEVENT` blocks directly from the plain-text iCal response — no library needed, Claude handles the format
4. Filters to events with `DTSTART` falling within the next 2–3 calendar days (relative to today in the container's `TZ`)
5. Composes a concise briefing (see format below)
6. Sends it via `mcp__nanoclaw__send_message`

**Important:** The skill must explicitly instruct Claude: "Do not include the iCal URL or any part of it in the message you send. It is a credential."

### Output format

When events exist:

```
Good morning. Here's your calendar for the next few days:

Today (Monday 13 Apr)
  14:00 — Doctor appointment
  18:30 — Dinner with Ana

Tomorrow (Tuesday 14 Apr)
  09:00 — Team standup
  11:00 — Call with landlord

Wednesday 15 Apr
  (nothing scheduled)
```

When no events in the next 3 days:

```
Good morning. Nothing on your calendar through Wednesday.
```

### iCal parsing notes

- `DTSTART` may be a date (`VALUE=DATE:20260413`) or datetime (`DTSTART:20260413T140000Z` or with `TZID`)
- All-day events use `VALUE=DATE` — include them, label without a time
- The container's `TZ` env var is set to the user's timezone by `buildContainerArgs` — use it when computing "today"
- Multi-line `SUMMARY` values use iCal folding (continuation lines start with a space) — unfold before displaying
- Recurring events (`RRULE`) are out of scope for v1 — skip events with `RRULE` and note this in the skill

---

## Part 3: Scheduled Task

The user creates the task via chat — no code change needed:

```
@Andy every day at 7am, run the calendar morning briefing skill
```

This creates a `cron`-type task via the existing `schedule_task` IPC flow, running against the main group in `isolated` context mode. The task prompt instructs Claude to invoke the `calendar-morning` skill.

---

## Deliverables

| File | Type | Description |
|---|---|---|
| `src/env.ts` | Edit | Add `readEnvFileByPrefix` helper |
| `src/container-runner.ts` | Edit | ~5 lines in `buildContainerArgs` to forward `CONTAINER_SECRET_*` vars |
| `container/skills/calendar-morning/SKILL.md` | New | Calendar morning briefing skill |
| `.env.example` | Edit | Document `CONTAINER_SECRET_PROTON_ICAL_URL` |
| `docs/HANDOFF.md` | Edit | Update with this change |

---

## Extensibility

This design is a foundation. Future extensions require no redesign:

| Extension | What it takes |
|---|---|
| Add work calendar | Add `CONTAINER_SECRET_WORK_ICAL_URL` to `.env`, update skill to fetch and merge both |
| Higher-frequency alerts | New skill + new task on a shorter interval; same `CONTAINER_SECRET_*` credential |
| Pre-meeting briefings | New skill that filters events within the next N hours + web search for participants |
| Other per-container credentials | Just add another `CONTAINER_SECRET_*` var to `.env` |

---

## Open Questions / Future Considerations

- **Recurring events:** `RRULE` parsing is skipped in v1. If recurring events (weekly standups, etc.) are important, a future version can add a small Python helper using the `icalendar` library, which would require adding one system package to the container image.
- **Proton Calendar sync frequency:** The iCal URL is fetched fresh on each task run (once/day). If the user adds an event in the afternoon, it won't appear until the next morning. This is acceptable for v1.
- **Silent days:** Whether to send "nothing scheduled" or stay silent on empty days is a user preference. The current design sends a brief "nothing through Wednesday" message. This can be changed in the skill.
