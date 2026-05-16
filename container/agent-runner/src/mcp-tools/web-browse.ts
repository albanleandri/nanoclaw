import { existsSync, readFileSync } from 'fs';
import { $ } from 'bun';

function log(msg: string): void {
  console.error(`[web-browse] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

// Path at which the trusted domains JSON is mounted inside the container.
export const TRUSTED_DOMAINS_PATH = '/workspace/group/trusted_domains.json';

// Known prompt injection patterns. Each regex must have the `g` and `i` flags.
export const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(your\s+)?(previous|prior|all)\s+instructions?/gi,
  /you\s+are\s+now\s+(a\s+)?different/gi,
  /system\s*:\s*(new\s+)?directive/gi,
  /override\s+(your\s+)?(guidelines?|instructions?|rules?)/gi,
  /SYSTEM\s+MESSAGE\s*:/gi,
  /disregard\s+(everything|all)\s+(above|before|prior)/gi,
  /new\s+instruction\s*:/gi,
  /forget\s+(everything|all)\s+(you\s+were|was)\s+told/gi,
];

/**
 * Extract the hostname from a URL, stripping the leading `www.` if present.
 * Returns an empty string if the URL cannot be parsed.
 */
export function parseDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Read the trusted domain list from a JSON file.
 * Returns an empty array on any error (missing file, bad JSON, wrong shape).
 */
export function loadTrustedDomains(configPath: string = TRUSTED_DOMAINS_PATH): string[] {
  try {
    if (!existsSync(configPath)) return [];
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is string => typeof d === 'string');
  } catch {
    return [];
  }
}

/**
 * Scan `text` for known injection patterns. Returns the sanitized text
 * (matching phrases replaced with `[content removed]`) and the list of
 * matched strings for reporting.
 *
 * Creates fresh RegExp objects per call to avoid `lastIndex` drift from
 * global-flag patterns shared across calls.
 */
export function sanitize(text: string): { clean: string; flagged: string[] } {
  const flagged: string[] = [];
  let clean = text;
  for (const { source, flags } of INJECTION_PATTERNS) {
    const re = new RegExp(source, flags);
    const matches = clean.match(re);
    if (matches) {
      flagged.push(...matches);
      clean = clean.replace(re, '[content removed]');
    }
  }
  return { clean, flagged };
}

// Module-level promise chain ensures only one agent-browser session runs at a time.
// agent-browser manages a single browser process per container.
let browserLock: Promise<void> = Promise.resolve();

async function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const acquired = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = browserLock;
  browserLock = acquired;
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function browseWebHandler(args: {
  url: string;
  fields_to_extract: string[];
}) {
  const { url, fields_to_extract: fieldsToExtract } = args;

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return err('url must start with http:// or https://');
  }

  const domain = parseDomain(url);
  if (!domain) return err(`Could not parse domain from URL: ${url}`);

  const trustedDomains = loadTrustedDomains();
  const trusted = trustedDomains.includes(domain);

  log(`browse url=${url} domain=${domain} trusted=${trusted} fields=[${fieldsToExtract.join(',')}]`);

  return withBrowserLock(async () => {
    try {
      await $`agent-browser open ${url}`.nothrow().quiet();
      const snapshot = await $`agent-browser snapshot -c`.nothrow().text();
      await $`agent-browser close`.nothrow().quiet();

      log(`done url=${url} snapshot_len=${snapshot.length}`);
      return buildBrowseResult(url, domain, trusted, snapshot, fieldsToExtract);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`error url=${url}: ${msg}`);
      await $`agent-browser close`.nothrow().quiet();
      return err(`Failed to browse ${url}: ${msg}`);
    }
  });
}

/**
 * Build the structured MCP response from a raw browser snapshot.
 * Pure function — no I/O. Exported for testing.
 */
export function buildBrowseResult(
  url: string,
  domain: string,
  trusted: boolean,
  snapshot: string,
  fieldsToExtract: string[],
) {
  const { clean, flagged } = sanitize(snapshot);

  const fields: Record<string, string> = {};
  fields.content = clean;
  if (fieldsToExtract.includes('summary')) {
    fields.summary = clean.slice(0, 1200).trim();
  }

  const result: Record<string, unknown> = { url, domain, trusted, fields };
  if (flagged.length > 0) {
    result.flagged = `Injection patterns detected and removed: ${flagged.join('; ')}`;
    log(`flagged injection patterns at ${url}: ${flagged.join(', ')}`);
  }

  return ok(JSON.stringify(result, null, 2));
}
