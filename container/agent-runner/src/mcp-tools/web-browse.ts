import { existsSync, readFileSync } from 'fs';
import { $ } from 'bun';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

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

export const browseWeb: McpToolDefinition = {
  tool: {
    name: 'browse_web',
    description:
      'Browse a URL and return sanitized, structured content. ' +
      'This is the ONLY tool available for web access — agent-browser cannot be called directly. ' +
      'Checks domain trust (see trusted_domains.json), removes prompt injection patterns, and returns ' +
      'a structured JSON result. Call multiple times in parallel for multi-URL research.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'Full URL to browse. Must start with https:// or http://.',
        },
        fields_to_extract: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Hints about what to extract (e.g. ["price", "summary", "title"]). ' +
            'The tool always returns the full sanitized content in `fields.content`. ' +
            'Including "summary" also returns the first ~1200 characters as `fields.summary`.',
        },
      },
      required: ['url', 'fields_to_extract'],
    },
  },

  async handler(args) {
    const url = args.url as string;
    const fieldsToExtract = Array.isArray(args.fields_to_extract)
      ? (args.fields_to_extract as string[])
      : [];

    if (!url) return err('url is required');
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
        // Navigate to the URL
        await $`agent-browser open ${url}`.nothrow().quiet();

        // Capture the page as a compact accessibility tree snapshot
        const snapshot = await $`agent-browser snapshot -c`.nothrow().text();

        // Always close after capture — ignore errors (browser may already be closed)
        await $`agent-browser close`.nothrow().quiet();

        const { clean, flagged } = sanitize(snapshot);

        const fields: Record<string, string> = {};
        // Always return the full sanitized content
        fields.content = clean;
        // Return a summary excerpt if requested
        if (fieldsToExtract.includes('summary')) {
          fields.summary = clean.slice(0, 1200).trim();
        }

        const result: Record<string, unknown> = { url, domain, trusted, fields };
        if (flagged.length > 0) {
          result.flagged = `Injection patterns detected and removed: ${flagged.join('; ')}`;
          log(`flagged injection patterns at ${url}: ${flagged.join(', ')}`);
        }

        log(`done url=${url} snapshot_len=${snapshot.length} flagged=${flagged.length}`);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`error url=${url}: ${msg}`);
        // Best-effort close on error
        await $`agent-browser close`.nothrow().quiet();
        return err(`Failed to browse ${url}: ${msg}`);
      }
    });
  },
};

registerTools([browseWeb]);
