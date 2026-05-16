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

// Handler and tool definition added in Task 3.
// Placeholder export so index.ts import compiles before Task 3 is complete.
export const browseWeb: McpToolDefinition = {
  tool: {
    name: 'browse_web',
    description: 'Browse a URL — implementation in progress.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  },
  async handler() {
    return { content: [{ type: 'text' as const, text: 'Error: not yet implemented' }], isError: true };
  },
};

registerTools([browseWeb]);
