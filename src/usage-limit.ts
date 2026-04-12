export interface UsageLimitState {
  detectedAt: string;
  suppressUntil: string;
  retryAt?: string;
  lastNotifiedAt: string;
  lastError: string;
}

export interface UsageLimitDetection {
  suppressUntil: string;
  retryAt?: string;
}

const DEFAULT_USAGE_LIMIT_SUPPRESS_MS = 15 * 60 * 1000;

const USAGE_LIMIT_PATTERNS = [
  /\b429\b/i,
  /rate limit/i,
  /usage limit/i,
  /quota/i,
  /too many requests/i,
  /credit balance/i,
  /request limit/i,
];

function parseExplicitRetryAt(error: string): string | undefined {
  const isoMatch = error.match(
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/,
  );
  if (isoMatch) {
    return isoMatch[0];
  }

  const utcMatch = error.match(
    /\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})? ?UTC\b/i,
  );
  if (!utcMatch) return undefined;

  const normalized = utcMatch[0]
    .replace(' UTC', 'Z')
    .replace(' ', 'T')
    .toUpperCase();
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function parseDurationMs(fragment: string): number | undefined {
  const matches = Array.from(
    fragment.matchAll(
      /(\d+)\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m(?!s\b)|seconds?|secs?|sec|s)\b/gi,
    ),
  );
  if (matches.length === 0) return undefined;

  let totalMs = 0;
  for (const match of matches) {
    const value = Number.parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit.startsWith('h')) {
      totalMs += value * 60 * 60 * 1000;
    } else if (unit.startsWith('m')) {
      totalMs += value * 60 * 1000;
    } else {
      totalMs += value * 1000;
    }
  }

  return totalMs > 0 ? totalMs : undefined;
}

function parseRelativeRetryAt(error: string, now: Date): string | undefined {
  const phraseMatch = error.match(
    /(?:try again|retry|available again|resets?|reset)\s+(?:in|after)\s+([^\n.]+)/i,
  );
  const durationMs = parseDurationMs(phraseMatch?.[1] ?? error);
  if (!durationMs) return undefined;
  return new Date(now.getTime() + durationMs).toISOString();
}

function sameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(a) === formatter.format(b);
}

export function detectUsageLimitError(
  error: string | undefined,
  now: Date = new Date(),
): UsageLimitDetection | null {
  if (!error) return null;
  if (!USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(error))) {
    return null;
  }

  const retryAt = parseExplicitRetryAt(error) ?? parseRelativeRetryAt(error, now);
  const suppressUntil =
    retryAt ??
    new Date(now.getTime() + DEFAULT_USAGE_LIMIT_SUPPRESS_MS).toISOString();

  return { retryAt, suppressUntil };
}

export function isUsageLimitActive(
  state: UsageLimitState | undefined,
  now: Date = new Date(),
): boolean {
  if (!state) return false;
  return new Date(state.suppressUntil).getTime() > now.getTime();
}

export function formatUsageLimitMessage(
  state: Pick<UsageLimitState, 'retryAt'>,
  timeZone: string,
  now: Date = new Date(),
): string {
  if (!state.retryAt) {
    return `Usage limit reached. I can't process requests right now. Reset time unavailable; try again later.`;
  }

  const retryAt = new Date(state.retryAt);
  const options: Intl.DateTimeFormatOptions = sameLocalDay(retryAt, now, timeZone)
    ? {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }
    : {
        timeZone,
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      };

  const formatted = new Intl.DateTimeFormat('en-US', options).format(retryAt);
  return `Usage limit reached. Try again after ${formatted} ${timeZone}.`;
}
