import fs from 'node:fs';
import path from 'node:path';

import type { MemoryRuntimeOptions } from './index.js';

const MAX_FINDINGS = 256;
const MAX_PATH_BYTES = 512;
const MAX_FILES = 4096;
const MAX_CONCEPT_BYTES = 64 * 1024;
const INDEX_MAX_BYTES = 12 * 1024;
const DEFINITION_MAX_BYTES = 8 * 1024;
const SUPPORTED_OKF_VERSION = '0.1';

export type MemoryValidationClassification =
  | 'root-unavailable'
  | 'unsupported-version'
  | 'missing-scaffold'
  | 'missing-type'
  | 'malformed-type'
  | 'unsafe-node'
  | 'symlink'
  | 'absolute-link'
  | 'escaping-link'
  | 'broken-link'
  | 'unreachable-concept'
  | 'duplicate-normalized-path'
  | 'oversized-always-loaded'
  | 'limit-exceeded';

export interface MemoryValidationFinding {
  classification: MemoryValidationClassification;
  path: string;
  target?: string;
}

export interface MemoryValidationReport {
  ok: boolean;
  root: string;
  okfVersion: string | null;
  scannedFiles: number;
  scannedDirectories: number;
  findings: MemoryValidationFinding[];
  truncated: boolean;
}

interface FileRecord {
  relative: string;
  bytes: number;
  content?: string;
  links: string[];
}

interface HelperReadResult {
  status: number;
  stdout: Buffer;
  stderr: string;
}

export interface ValidatorOptions extends MemoryRuntimeOptions {
  spawnHelper?: (args: string[]) => HelperReadResult;
}

function boundedPath(value: string): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= MAX_PATH_BYTES) return value;
  return `${buffer.subarray(0, MAX_PATH_BYTES - 3).toString('utf8')}...`;
}

function runHelper(root: string, relative: string, options: ValidatorOptions): HelperReadResult {
  if (options.spawnHelper) return options.spawnHelper(['read', root, relative, String(MAX_CONCEPT_BYTES)]);
  const result = Bun.spawnSync([
    options.helperPath ?? '/usr/local/bin/nanoclaw-memory-fs',
    'read',
    root,
    relative,
    String(MAX_CONCEPT_BYTES),
  ]);
  return {
    status: result.exitCode,
    stdout: Buffer.from(result.stdout),
    stderr: Buffer.from(result.stderr).toString('utf8').trim(),
  };
}

function scalarFrontmatter(content: string, key: 'type' | 'okf_version'): { value: string | null; malformed: boolean } {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content.slice(0, 4096))?.[1];
  if (!block) return { value: null, malformed: false };
  const line = block.split(/\r?\n/).find((entry) => entry.startsWith(`${key}:`));
  if (!line) return { value: null, malformed: false };
  const raw = line.slice(key.length + 1).trim();
  if (!raw || raw.startsWith('[') || raw.startsWith('{') || raw.startsWith('|') || raw.startsWith('>')) {
    return { value: null, malformed: true };
  }
  const value = raw.replace(/^(['"])(.*)\1$/, '$2').trim();
  return { value: value || null, malformed: !value };
}

function markdownLinks(content: string): string[] {
  return [...content.matchAll(/!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)].map((match) => match[1]);
}

function normalizedKey(relative: string): string {
  return relative.normalize('NFC').toLocaleLowerCase('en-US');
}

function decodeLinkTarget(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function validateMemoryTree(root: string, options: ValidatorOptions = {}): MemoryValidationReport {
  const findings: MemoryValidationFinding[] = [];
  let truncated = false;
  const add = (classification: MemoryValidationClassification, relative: string, target?: string): void => {
    if (findings.length >= MAX_FINDINGS) {
      truncated = true;
      return;
    }
    findings.push({
      classification,
      path: boundedPath(relative || '.'),
      ...(target ? { target: boundedPath(target) } : {}),
    });
  };

  const report = (okfVersion: string | null, files: FileRecord[], directories: number): MemoryValidationReport => ({
    ok: findings.length === 0 && !truncated,
    root: '/workspace/agent/memory',
    okfVersion,
    scannedFiles: files.length,
    scannedDirectories: directories,
    findings,
    truncated,
  });

  let rootEntries: fs.Dirent[];
  try {
    if (!fs.lstatSync(root).isDirectory()) throw new Error('not-directory');
    rootEntries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    add('root-unavailable', '.');
    return report(null, [], 0);
  }

  const files: FileRecord[] = [];
  const queue: Array<{ absolute: string; relative: string; entries: fs.Dirent[] }> = [
    { absolute: root, relative: '', entries: rootEntries },
  ];
  let directories = 1;
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const entry of current.entries) {
      if (files.length + directories > MAX_FILES) {
        add('limit-exceeded', current.relative || '.');
        truncated = true;
        queue.length = 0;
        break;
      }
      const relative = path.posix.join(current.relative, entry.name);
      const absolute = path.join(current.absolute, entry.name);
      if (entry.isSymbolicLink()) {
        add('symlink', relative);
      } else if (entry.isDirectory()) {
        directories++;
        try {
          queue.push({ absolute, relative, entries: fs.readdirSync(absolute, { withFileTypes: true }) });
        } catch {
          add('unsafe-node', relative);
        }
      } else if (entry.isFile()) {
        const stat = fs.lstatSync(absolute);
        const record: FileRecord = { relative, bytes: stat.size, links: [] };
        if (path.extname(relative).toLowerCase() === '.md') {
          const read = runHelper(root, relative, options);
          if (read.status === 0) {
            record.content = read.stdout.toString('utf8');
            record.links = markdownLinks(record.content);
          } else {
            add('unsafe-node', relative);
          }
        }
        files.push(record);
      } else {
        add('unsafe-node', relative);
      }
    }
  }

  const byPath = new Map(files.map((file) => [file.relative, file]));
  for (const reserved of ['index.md', 'system/index.md', 'system/definition.md']) {
    if (!byPath.has(reserved)) add('missing-scaffold', reserved);
  }

  const rootIndex = byPath.get('index.md');
  const version = rootIndex?.content ? scalarFrontmatter(rootIndex.content, 'okf_version').value : null;
  if (version !== SUPPORTED_OKF_VERSION) add('unsupported-version', 'index.md');
  if (rootIndex && rootIndex.bytes > INDEX_MAX_BYTES) add('oversized-always-loaded', 'index.md');
  const definition = byPath.get('system/definition.md');
  if (definition && definition.bytes > DEFINITION_MAX_BYTES) add('oversized-always-loaded', 'system/definition.md');

  const normalized = new Map<string, string>();
  for (const file of files) {
    const key = normalizedKey(file.relative);
    const previous = normalized.get(key);
    if (previous && previous !== file.relative) add('duplicate-normalized-path', file.relative, previous);
    else normalized.set(key, file.relative);

    if (!file.content || file.relative === 'index.md') continue;
    const type = scalarFrontmatter(file.content, 'type');
    if (type.malformed) add('malformed-type', file.relative);
    else if (!type.value) add('missing-type', file.relative);
  }

  const graph = new Map<string, string[]>();
  for (const file of files) {
    const targets: string[] = [];
    for (const rawTarget of file.links) {
      const target = decodeLinkTarget(rawTarget.split('#')[0]);
      if (target === null) {
        add('broken-link', file.relative, rawTarget);
        continue;
      }
      if (!target) continue;
      if (target.startsWith('/')) {
        add('absolute-link', file.relative, target);
        continue;
      }
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.relative), target));
      if (resolved === '..' || resolved.startsWith('../')) {
        add('escaping-link', file.relative, target);
        continue;
      }
      if (!byPath.has(resolved)) {
        add('broken-link', file.relative, target);
        continue;
      }
      targets.push(resolved);
    }
    graph.set(file.relative, targets);
  }

  const reachable = new Set<string>();
  const pending = ['index.md'];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    pending.push(...(graph.get(current) ?? []));
  }
  for (const file of files) {
    if (file.relative.endsWith('.md') && file.relative !== 'index.md' && !reachable.has(file.relative)) {
      add('unreachable-concept', file.relative);
    }
  }
  return report(version, files, directories);
}
