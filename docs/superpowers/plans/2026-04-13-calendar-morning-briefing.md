# Calendar Morning Briefing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a daily 7 AM calendar briefing that fetches Proton Calendar via a secret iCal URL, parses the next 2–3 days of events, and sends a summary to the main chat.

**Architecture:** Two host-side changes (a new `readEnvFileByPrefix` helper + 5-line addition to `buildContainerArgs`) plus a new container skill (`calendar-morning`). No new processes, no schema changes, no new dependencies. The iCal URL is stored in `.env` under the `CONTAINER_SECRET_` prefix and forwarded to containers as an env var.

**Tech Stack:** TypeScript + Vitest (host), iCalendar plain-text format (parsed inside container by Claude), existing `mcp__nanoclaw__send_message` IPC, `WebFetch` tool.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/env.ts` | Modify | Add `readEnvFileByPrefix(prefix)` export |
| `src/env.test.ts` | Create | Unit tests for `readEnvFileByPrefix` |
| `src/container-runner.ts` | Modify | Import + call `readEnvFileByPrefix` in `buildContainerArgs` |
| `src/container-runner.test.ts` | Modify | Add `CONTAINER_SECRET_*` forwarding tests |
| `container/skills/calendar-morning/SKILL.md` | Create | Calendar morning briefing skill |
| `.env.example` | Modify | Document `CONTAINER_SECRET_PROTON_ICAL_URL` |
| `docs/HANDOFF.md` | Modify | Update with this change |

---

## Task 1: `readEnvFileByPrefix` in `src/env.ts`

**Files:**
- Create: `src/env.test.ts`
- Modify: `src/env.ts`

- [ ] **Step 1.1: Write the failing tests in `src/env.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
    },
  };
});

import { readEnvFileByPrefix } from './env.js';

describe('readEnvFileByPrefix', () => {
  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockReset();
  });

  it('returns vars matching prefix, excludes others', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      'CONTAINER_SECRET_ICAL_URL=https://example.com\nANTHROPIC_API_KEY=secret\n',
    );
    expect(readEnvFileByPrefix('CONTAINER_SECRET_')).toEqual({
      CONTAINER_SECRET_ICAL_URL: 'https://example.com',
    });
  });

  it('returns multiple vars matching prefix', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      'CONTAINER_SECRET_A=foo\nCONTAINER_SECRET_B=bar\n',
    );
    expect(readEnvFileByPrefix('CONTAINER_SECRET_')).toEqual({
      CONTAINER_SECRET_A: 'foo',
      CONTAINER_SECRET_B: 'bar',
    });
  });

  it('returns empty object when no vars match prefix', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('ANTHROPIC_API_KEY=key\n');
    expect(readEnvFileByPrefix('CONTAINER_SECRET_')).toEqual({});
  });

  it('returns empty object when .env is missing', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(readEnvFileByPrefix('CONTAINER_SECRET_')).toEqual({});
  });

  it('strips double quotes from values', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      'CONTAINER_SECRET_URL="https://example.com"\n',
    );
    expect(readEnvFileByPrefix('CONTAINER_SECRET_')).toEqual({
      CONTAINER_SECRET_URL: 'https://example.com',
    });
  });

  it('strips single quotes from values', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      "CONTAINER_SECRET_URL='https://example.com'\n",
    );
    expect(readEnvFileByPrefix('CONTAINER_SECRET_')).toEqual({
      CONTAINER_SECRET_URL: 'https://example.com',
    });
  });

  it('ignores comment lines', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      '# CONTAINER_SECRET_IGNORED=value\nCONTAINER_SECRET_REAL=ok\n',
    );
    expect(readEnvFileByPrefix('CONTAINER_SECRET_')).toEqual({
      CONTAINER_SECRET_REAL: 'ok',
    });
  });

  it('ignores vars with empty values', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('CONTAINER_SECRET_EMPTY=\n');
    expect(readEnvFileByPrefix('CONTAINER_SECRET_')).toEqual({});
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

```bash
npm test -- src/env.test.ts
```

Expected: FAIL — `readEnvFileByPrefix is not a function` (or similar export error)

- [ ] **Step 1.3: Add `readEnvFileByPrefix` to `src/env.ts`**

Add this function after the existing `readEnvFile` function (after line 43):

```typescript
/**
 * Returns all key/value pairs from .env whose keys start with prefix.
 * Follows the same quote-stripping and comment-skipping logic as readEnvFile.
 */
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
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }
  return result;
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

```bash
npm test -- src/env.test.ts
```

Expected: 8 tests pass

- [ ] **Step 1.5: Run full test suite**

```bash
npm test
```

Expected: all existing tests still pass

- [ ] **Step 1.6: Commit**

```bash
git add src/env.ts src/env.test.ts
git commit -m "feat: add readEnvFileByPrefix to env.ts"
```

---

## Task 2: Forward `CONTAINER_SECRET_*` vars in `container-runner.ts`

**Files:**
- Modify: `src/container-runner.ts`
- Modify: `src/container-runner.test.ts`

- [ ] **Step 2.1: Add mock and failing tests to `src/container-runner.test.ts`**

Add the `./env.js` mock immediately after the `./credential-proxy.js` mock (around line 68), and add the import for `spawn` and `readEnvFileByPrefix` after the existing imports at the bottom of the mock/import section:

**Add this mock** (after the `vi.mock('./credential-proxy.js', ...)` block):

```typescript
// Mock env.ts prefix reader — returns no secrets by default
vi.mock('./env.js', () => ({
  readEnvFileByPrefix: vi.fn(() => ({})),
}));
```

**Add these imports** (after `import { runContainerAgent, ContainerOutput } from './container-runner.js'`):

```typescript
import { spawn } from 'child_process';
import { readEnvFileByPrefix } from './env.js';
```

**Add this describe block** at the end of the file:

```typescript
describe('CONTAINER_SECRET_* env var forwarding', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(readEnvFileByPrefix).mockReturnValue({});
  });

  it('forwards CONTAINER_SECRET_* vars as -e flags to the container', async () => {
    vi.mocked(readEnvFileByPrefix).mockReturnValue({
      CONTAINER_SECRET_PROTON_ICAL_URL: 'https://calendar.example.com/ical',
    });

    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      vi.fn(),
      onOutput,
    );

    // spawn is called synchronously inside runContainerAgent — check args now
    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    const secretIdx = spawnArgs.indexOf(
      'CONTAINER_SECRET_PROTON_ICAL_URL=https://calendar.example.com/ical',
    );
    expect(secretIdx).toBeGreaterThan(0);
    expect(spawnArgs[secretIdx - 1]).toBe('-e');

    // Clean up: resolve the promise so no leak
    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('does not add -e flags when no CONTAINER_SECRET_* vars are set', async () => {
    vi.mocked(readEnvFileByPrefix).mockReturnValue({});

    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      vi.fn(),
      onOutput,
    );

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    const hasContainerSecret = spawnArgs.some((a) =>
      String(a).startsWith('CONTAINER_SECRET_'),
    );
    expect(hasContainerSecret).toBe(false);

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
npm test -- src/container-runner.test.ts
```

Expected: the two new tests fail — `readEnvFileByPrefix` is not yet imported in `container-runner.ts`, so `CONTAINER_SECRET_*` vars do not appear in spawn args.

- [ ] **Step 2.3: Add the import and forwarding code to `src/container-runner.ts`**

**Add import** at the top of `src/container-runner.ts`, alongside the other local imports:

```typescript
import { readEnvFileByPrefix } from './env.js';
```

**Add forwarding** inside `buildContainerArgs`, after the auth token env var block (after the `args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder')` / `args.push('-e', 'ANTHROPIC_API_KEY=placeholder')` lines, before `args.push(...hostGatewayArgs())`):

```typescript
  // Forward CONTAINER_SECRET_* vars from .env to the container.
  // Explicitly opt-in (prefix required) — no other .env vars are forwarded.
  // The .env file itself is shadowed (/dev/null) inside containers.
  const containerSecrets = readEnvFileByPrefix('CONTAINER_SECRET_');
  for (const [key, value] of Object.entries(containerSecrets)) {
    args.push('-e', `${key}=${value}`);
  }
```

- [ ] **Step 2.4: Run tests to verify they pass**

```bash
npm test -- src/container-runner.test.ts
```

Expected: all tests pass, including the two new ones

- [ ] **Step 2.5: Run full test suite**

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 2.6: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat: forward CONTAINER_SECRET_* env vars into containers"
```

---

## Task 3: Create the `calendar-morning` container skill

**Files:**
- Create: `container/skills/calendar-morning/SKILL.md`

- [ ] **Step 3.1: Create the skill directory and SKILL.md**

Create `container/skills/calendar-morning/SKILL.md` with this exact content:

```markdown
---
name: calendar-morning
description: Daily morning calendar briefing. Fetches personal Proton Calendar via iCal URL, summarises the next 2-3 days of events, and sends a message. Run once daily at 7:00 AM.
---

You are running the daily morning calendar briefing task.

## Step 1: Get the iCal URL

Run this Bash command to read the iCal URL from the environment:

```bash
echo "$CONTAINER_SECRET_PROTON_ICAL_URL"
```

If the output is empty or blank, send this message via mcp__nanoclaw__send_message and stop — do not proceed further:

```
⚠️ Calendar morning briefing could not run: CONTAINER_SECRET_PROTON_ICAL_URL is not set. Add it to your .env file.
```

## Step 2: Fetch the calendar

Use the WebFetch tool with the URL you obtained in Step 1. The response is plain text in iCalendar (.ics) format.

Do NOT include the iCal URL anywhere in the message you send to the user — it is a credential.

## Step 3: Determine today's date

Run:

```bash
date +"%Y-%m-%d"
```

This gives you today's date in the container's local timezone (which matches your timezone). Compute tomorrow and the day after tomorrow from this value.

## Step 4: Parse upcoming events

Scan the iCal response text for VEVENT blocks — everything between `BEGIN:VEVENT` and `END:VEVENT`.

For each VEVENT, extract:
- `DTSTART` — the event start date/time
- `SUMMARY` — the event title
- `LOCATION` — optional, only include if it names a physical place (not a URL)

**Skip** any VEVENT that contains an `RRULE` line (recurring events are not supported in this version).

**Date formats you will encounter:**
- All-day: `DTSTART;VALUE=DATE:20260413` → date only, no time
- With timezone: `DTSTART;TZID=Europe/Lisbon:20260413T140000` → 14:00 local time
- UTC: `DTSTART:20260413T140000Z` → convert to local time using the TZ env var

**Multi-line SUMMARY** (iCal folding): a line that begins with a single space continues the previous line. Strip the leading space and join it to the previous line before reading the value.

**Filter** to events where DTSTART falls on today, tomorrow, or the day after tomorrow.

## Step 5: Compose the morning message

**Format when events exist:**

```
Good morning. Here's your calendar for the next few days:

Today (Monday 13 Apr)
  14:00 — Doctor appointment
  18:30 — Dinner with Ana

Tomorrow (Tuesday 14 Apr)
  09:00 — Team standup
  All day — Public Holiday

Wednesday 15 Apr
  (nothing scheduled)
```

**Format when no events in the next 3 days:**

```
Good morning. Nothing on your calendar through [day name of day after tomorrow].
```

**Rules:**
- Always show all three days (today, tomorrow, day after), even if empty
- All-day events: show the title with the prefix `All day —` (no time)
- Timed events: show `HH:MM —` prefix in 24-hour format in local timezone
- Sort events within each day: all-day events first, then timed events by start time
- If LOCATION contains a physical address or place name (not a URL, not a meeting link), append it in parentheses: `14:00 — Doctor appointment (Clínica X, Rua Y)`
- Keep it short — no extra commentary, just the schedule

## Step 6: Send the message

Use mcp__nanoclaw__send_message to send the composed message.
```

- [ ] **Step 3.2: Verify the skill file is in the right location**

```bash
ls container/skills/calendar-morning/
```

Expected output: `SKILL.md`

- [ ] **Step 3.3: Commit**

```bash
git add container/skills/calendar-morning/SKILL.md
git commit -m "feat: add calendar-morning container skill"
```

---

## Task 4: Update `.env.example` and `docs/HANDOFF.md`

**Files:**
- Modify: `.env.example`
- Modify: `docs/HANDOFF.md`

- [ ] **Step 4.1: Update `.env.example`**

The current content of `.env.example` is:
```
OLLAMA_HOST=
```

Replace it with:

```
OLLAMA_HOST=

# --- Container Secrets ---
# Variables prefixed with CONTAINER_SECRET_ are forwarded as env vars into
# agent containers. They are never committed — keep this file gitignored.

# Proton Calendar iCal URL (personal calendar)
# Get it from: Proton Calendar → Settings → Your calendars → [calendar] → Copy link
# CONTAINER_SECRET_PROTON_ICAL_URL=https://calendar.proton.me/api/calendar/v1/...
```

- [ ] **Step 4.2: Update `docs/HANDOFF.md`**

Replace the `## Files changed (latest)` and `## Commands run` sections with entries for this change:

```markdown
## Files changed (latest)
- `src/env.ts` — added `readEnvFileByPrefix(prefix)` export; reads `.env` and returns all keys matching the given prefix
- `src/env.test.ts` — new unit tests for `readEnvFileByPrefix`
- `src/container-runner.ts` — imports `readEnvFileByPrefix`; `buildContainerArgs` now forwards all `CONTAINER_SECRET_*` vars from `.env` as `-e` flags to the container
- `src/container-runner.test.ts` — two new tests verifying `CONTAINER_SECRET_*` forwarding behaviour
- `container/skills/calendar-morning/SKILL.md` — new container skill: fetches Proton Calendar via iCal URL, parses next 2-3 days, sends a morning briefing
- `.env.example` — documents `CONTAINER_SECRET_PROTON_ICAL_URL`

## Commands run
- `npm test` → all tests pass

## Test/lint status
- `npm test` passed (all tests including new env and container-runner tests).

## Open issues / next steps
- User needs to: (1) add `CONTAINER_SECRET_PROTON_ICAL_URL=<url>` to `.env`, (2) tell the assistant `@Andy every day at 7am, run the calendar morning briefing using the calendar-morning skill` to create the scheduled task
- Recurring events (RRULE) are skipped in v1 — revisit if they matter
- Future: add work calendar via `CONTAINER_SECRET_WORK_ICAL_URL`
```

- [ ] **Step 4.3: Run final test suite**

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 4.4: Commit**

```bash
git add .env.example docs/HANDOFF.md
git commit -m "docs: document CONTAINER_SECRET_PROTON_ICAL_URL and update handoff"
```

---

## User Setup (after deploy)

Once the code is built and deployed, the user needs to:

1. Add to `.env`:
   ```
   CONTAINER_SECRET_PROTON_ICAL_URL=https://calendar.proton.me/api/calendar/v1/<your-secret-url>
   ```

2. Restart the service:
   ```bash
   npm run service:restart
   ```

3. Tell the assistant:
   ```
   @Andy every day at 7am, run the calendar morning briefing using the calendar-morning skill
   ```
