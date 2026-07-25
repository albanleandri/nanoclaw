import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import Database from 'better-sqlite3';

export type FindingCategory =
  | 'provider-specific'
  | 'provider-compatible-fallback'
  | 'channel-specific'
  | 'historical/reference'
  | 'test-fixture'
  | 'memory-surface'
  | 'blocker';

export interface AuditFinding {
  source: string;
  line?: number;
  pattern: string;
  category: FindingCategory;
  surface: 'active-instruction' | 'generated-provider-doc' | 'shared-resource' | 'live-task' | 'private-memory';
  excerpt?: string;
}

interface PatternRule {
  label: string;
  regex: RegExp;
  category: FindingCategory;
}

const RULES: PatternRule[] = [
  {
    label: '/home/node/.claude/skills',
    regex: /\/home\/node\/\.claude\/skills/g,
    category: 'provider-compatible-fallback',
  },
  { label: '/workspace/group', regex: /\/workspace\/group/g, category: 'provider-compatible-fallback' },
  { label: 'Skill(...)', regex: /\bSkill\s*\(/g, category: 'provider-specific' },
  {
    label: 'Claude Task tool',
    regex: /\b(?:Claude\s+)?Task(?:\s+tool|\s+subagent|\s*\()/gi,
    category: 'provider-specific',
  },
  {
    label: 'provider model name',
    regex: /\b(?:haiku|sonnet|opus|gpt-[A-Za-z0-9._-]+|o[134](?:-[A-Za-z0-9._-]+)?)\b/gi,
    category: 'provider-specific',
  },
  { label: 'bot_index', regex: /\bbot_index\b/g, category: 'channel-specific' },
  {
    label: 'hard-coded agent group id',
    regex: /\b(?:ag-[a-z0-9][a-z0-9-]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/gi,
    category: 'blocker',
  },
];

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.ts', '.tsx', '.js', '.json', '.toml', '.yaml', '.yml']);

function lineNumber(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function classifyForPath(filePath: string, base: FindingCategory): FindingCategory {
  const normalized = filePath.replaceAll(path.sep, '/').toLowerCase();
  if (/(^|\/)(?:test|tests|fixtures?)(\/|\.|$)/.test(normalized) || /\.test\.[^.]+$/.test(normalized)) {
    return 'test-fixture';
  }
  if (normalized.includes('/docs/') || normalized.includes('/archive') || normalized.includes('/history')) {
    return 'historical/reference';
  }
  return base;
}

function surfaceForPath(filePath: string): AuditFinding['surface'] {
  const normalized = filePath.replaceAll(path.sep, '/');
  if (normalized.includes('/groups/') && /\/(?:CLAUDE|AGENTS)\.md$/.test(normalized)) {
    return 'generated-provider-doc';
  }
  if (normalized.includes('/groups/shared/') || normalized.includes('/shared/')) return 'shared-resource';
  return 'active-instruction';
}

export function scanText(source: string, content: string, includeExcerpt = false): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    for (const match of content.matchAll(rule.regex)) {
      const index = match.index ?? 0;
      const line = lineNumber(content, index);
      findings.push({
        source,
        line,
        pattern: rule.label,
        category: classifyForPath(source, rule.category),
        surface: surfaceForPath(source),
        ...(includeExcerpt ? { excerpt: content.split('\n')[line - 1]?.trim().slice(0, 240) } : {}),
      });
    }
  }
  return findings;
}

function walkTextFiles(root: string, skipPrivateMemory = false): string[] {
  if (!fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return TEXT_EXTENSIONS.has(path.extname(root).toLowerCase()) ? [root] : [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'downloads') continue;
    if (skipPrivateMemory && entry.name === 'memory') continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkTextFiles(fullPath, skipPrivateMemory));
    else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(fullPath);
  }
  return files;
}

function scanPrivateMemoryMetadata(projectRoot: string): AuditFinding[] {
  const groupsRoot = path.join(projectRoot, 'groups');
  if (!fs.existsSync(groupsRoot)) return [];
  const findings: AuditFinding[] = [];
  for (const group of fs.readdirSync(groupsRoot, { withFileTypes: true })) {
    if (!group.isDirectory() || group.name === 'shared') continue;
    const memoryRoot = path.join(groupsRoot, group.name, 'memory');
    if (!fs.existsSync(memoryRoot)) continue;
    const pending = [memoryRoot];
    let count = 0;
    while (pending.length > 0 && count < 4096) {
      const current = pending.pop()!;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        count++;
        const fullPath = path.join(current, entry.name);
        const source = path.relative(projectRoot, fullPath);
        findings.push({
          source,
          pattern: entry.isSymbolicLink() ? 'private memory symlink' : 'private memory node',
          category: 'memory-surface',
          surface: 'private-memory',
        });
        if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(fullPath);
        if (count >= 4096) break;
      }
    }
  }
  return findings;
}

function findInboundDbs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...findInboundDbs(fullPath));
    else if (entry.isFile() && entry.name === 'inbound.db') results.push(fullPath);
  }
  return results;
}

export function scanTaskDb(dbPath: string, projectRoot: string, includeExcerpt = false): AuditFinding[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const rows = db
      .prepare(
        `SELECT id, content
         FROM messages_in
         WHERE kind = 'task' AND status IN ('pending', 'paused')
         ORDER BY id`,
      )
      .all() as Array<{ id: string; content: string }>;
    return rows.flatMap((row) =>
      scanText(`${path.relative(projectRoot, dbPath)}#task:${row.id}`, row.content, includeExcerpt).map((finding) => ({
        ...finding,
        surface: 'live-task' as const,
      })),
    );
  } finally {
    db.close();
  }
}

export function runAudit(projectRoot: string, includeExcerpt = false): AuditFinding[] {
  const roots = [
    path.join(projectRoot, 'container', 'skills'),
    path.join(projectRoot, 'container', 'CLAUDE.md'),
    path.join(projectRoot, 'groups'),
  ];
  const findings = roots
    .flatMap((root) => walkTextFiles(root, root === path.join(projectRoot, 'groups')))
    .sort()
    .flatMap((filePath) =>
      scanText(path.relative(projectRoot, filePath), fs.readFileSync(filePath, 'utf8'), includeExcerpt),
    );
  for (const dbPath of findInboundDbs(path.join(projectRoot, 'data', 'v2-sessions')).sort()) {
    findings.push(...scanTaskDb(dbPath, projectRoot, includeExcerpt));
  }
  findings.push(...scanPrivateMemoryMetadata(projectRoot));
  return findings.sort(
    (a, b) => a.source.localeCompare(b.source) || (a.line ?? 0) - (b.line ?? 0) || a.pattern.localeCompare(b.pattern),
  );
}

export function renderMarkdown(findings: AuditFinding[]): string {
  const counts = new Map<FindingCategory, number>();
  for (const finding of findings) counts.set(finding.category, (counts.get(finding.category) ?? 0) + 1);
  return [
    '# Model-neutral portability audit',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `Findings: ${findings.length}`,
    '',
    ...[...counts.entries()].sort().map(([category, count]) => `- ${category}: ${count}`),
    '',
    '| Source | Line | Pattern | Category | Surface |',
    '| --- | ---: | --- | --- | --- |',
    ...findings.map(
      (finding) =>
        `| ${finding.source.replaceAll('|', '\\|')} | ${finding.line ?? ''} | ${finding.pattern} | ${finding.category} | ${finding.surface} |`,
    ),
    '',
  ].join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : 'markdown';
  const findings = runAudit(process.cwd(), args.includes('--details'));
  if (format === 'json') console.log(JSON.stringify({ findings }, null, 2));
  else if (format === 'markdown') console.log(renderMarkdown(findings));
  else throw new Error(`Unsupported format: ${format}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
