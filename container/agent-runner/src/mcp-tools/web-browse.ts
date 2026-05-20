import { existsSync, readFileSync } from 'fs';
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
export const TRUSTED_DOMAINS_PATH = '/workspace/agent/trusted_domains.json';

// Known prompt injection patterns. Each regex must have the `g` and `i` flags.
export const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(your\s+)?(previous|prior|all)\s+instructions?/gi,
  /you\s+are\s+now\s+(a\s+)?different/gi,
  /system\s*:\s*(new\s+)?directive/gi,
  /override\s+(your\s+)?(guidelines?|instructions?|rules?)/gi,
  /SYSTEM\s+MESSAGE\s*:/g,
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
      clean = clean.replace(new RegExp(source, flags), '[content removed]');
    }
  }
  return { clean, flagged };
}

export function isTrustedDomain(domain: string, trustedDomains: string[]): boolean {
  return trustedDomains.some((trusted) => domain === trusted || domain.endsWith(`.${trusted}`));
}

function htmlToText(raw: string): string {
  return raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export interface BrowseWebArgs {
  url?: unknown;
  fields_to_extract?: unknown;
  fetch?: typeof globalThis.fetch;
}

export async function browseWebHandler(args: BrowseWebArgs) {
  const url = typeof args.url === 'string' ? args.url : '';
  if (!url) return err('url is required');
  if (!/^https?:\/\//i.test(url)) return err('url must start with http:// or https://');

  const domain = parseDomain(url);
  if (!domain) return err('invalid URL');

  const fetchFn = args.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: {
        'user-agent': 'NanoClaw browse_web/1.0',
        accept: 'text/html,text/plain,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      },
    });
  } catch (fetchErr) {
    return err(`fetch failed: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
  }

  if (!res.ok) return err(`fetch failed: ${res.status} ${res.statusText}`.trim());

  const contentType = res.headers.get('content-type') ?? '';
  const raw = await res.text();
  const extracted = contentType.includes('html') ? htmlToText(raw) : raw.replace(/\s+/g, ' ').trim();
  const { clean, flagged } = sanitize(extracted);

  const fieldsToExtract = Array.isArray(args.fields_to_extract)
    ? args.fields_to_extract.filter((f): f is string => typeof f === 'string')
    : [];
  const fields: Record<string, string> = { content: clean };
  if (fieldsToExtract.includes('summary')) {
    fields.summary = clean.slice(0, 1200);
  }

  const trustedDomains = loadTrustedDomains();
  const result = {
    url,
    domain,
    trusted: isTrustedDomain(domain, trustedDomains),
    sanitized: flagged.length > 0,
    flaggedPatterns: flagged,
    fields,
  };

  return ok(JSON.stringify(result, null, 2));
}

export const browseWeb: McpToolDefinition = {
  tool: {
    name: 'browse_web',
    description:
      'Browse a URL, strip active content, remove known prompt-injection phrases, and return structured JSON.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Full URL to browse. Must start with https:// or http://.' },
        fields_to_extract: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional extraction hints. Include "summary" to get a short summary field.',
        },
      },
      required: ['url'],
    },
  },
  handler: browseWebHandler,
};

registerTools([browseWeb]);
