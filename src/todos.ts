import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';

export interface TodoItem {
  text: string;
  completed: boolean;
  due: string | null;
}

export const SHARED_TODO_RESOURCE = 'knowledge';
export const SHARED_TODO_FILENAME = 'TODO.md';

export function sharedTodoPath(groupsDir = GROUPS_DIR): string {
  return path.join(groupsDir, 'shared', SHARED_TODO_RESOURCE, SHARED_TODO_FILENAME);
}

const TODO_PATH = sharedTodoPath();
const ITEM_RE = /^- \[([ xX])\] (.*?)(?: 📅 (\d{4}-\d{2}-\d{2}))?$/;

function validateText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  const text = value.trim();
  if (/[\r\n\0]/.test(text)) throw new Error(`${name} must be a single line`);
  return text;
}

function validateDue(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const due = validateText(value, 'due');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('due must use YYYY-MM-DD');
  const date = new Date(`${due}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== due) {
    throw new Error('due must be a valid calendar date');
  }
  return due;
}

function readDocument(todoPath = TODO_PATH): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(todoPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`to-do list not found: ${todoPath}`, { cause: error });
    }
    throw error;
  }
  if (!stat.isFile()) throw new Error(`to-do list must be a regular file: ${todoPath}`);
  return fs.readFileSync(todoPath, 'utf8');
}

function parseLine(line: string): TodoItem | null {
  const match = ITEM_RE.exec(line);
  if (!match) return null;
  return { completed: match[1].toLowerCase() === 'x', text: match[2], due: match[3] ?? null };
}

function atomicWrite(todoPath: string, content: string): void {
  const tempPath = `${todoPath}.tmp-${process.pid}-${Date.now()}`;
  const mode = fs.statSync(todoPath).mode & 0o777;
  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode, flag: 'wx' });
    fs.renameSync(tempPath, todoPath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AggregateError(
          [error, cleanupError],
          `failed to update and clean temporary to-do file: ${tempPath}`,
          {
            cause: cleanupError,
          },
        );
      }
    }
    throw error;
  }
}

function findMatch(lines: string[], rawMatch: unknown, completed: boolean): { index: number; item: TodoItem } {
  const needle = validateText(rawMatch, 'match').toLocaleLowerCase();
  const matches = lines
    .map((line, index) => ({ index, item: parseLine(line) }))
    .filter(
      (entry): entry is { index: number; item: TodoItem } =>
        entry.item !== null &&
        entry.item.completed === completed &&
        entry.item.text.toLocaleLowerCase().includes(needle),
    );
  if (matches.length === 0)
    throw new Error(`no ${completed ? 'completed' : 'active'} to-do matches: ${String(rawMatch)}`);
  if (matches.length > 1) {
    throw new Error(`match is ambiguous: ${matches.map((entry) => entry.item.text).join(' | ')}`);
  }
  return matches[0];
}

export function listTodos(todoPath = TODO_PATH): TodoItem[] {
  return readDocument(todoPath)
    .split('\n')
    .map(parseLine)
    .filter((item): item is TodoItem => item !== null);
}

export function addTodo(rawText: unknown, rawDue?: unknown, todoPath = TODO_PATH): TodoItem {
  const text = validateText(rawText, 'text');
  const due = validateDue(rawDue);
  const document = readDocument(todoPath);
  if (
    listTodos(todoPath).some((item) => item.text.toLocaleLowerCase() === text.toLocaleLowerCase() && !item.completed)
  ) {
    throw new Error(`active to-do already exists: ${text}`);
  }
  const marker = '## Active\n';
  const markerIndex = document.indexOf(marker);
  if (markerIndex < 0) throw new Error('to-do list is missing the Active section');
  const insertAt = markerIndex + marker.length;
  const line = `\n- [ ] ${text}${due ? ` 📅 ${due}` : ''}`;
  atomicWrite(todoPath, document.slice(0, insertAt) + line + document.slice(insertAt));
  return { text, completed: false, due };
}

export function updateTodo(rawMatch: unknown, rawText?: unknown, rawDue?: unknown, todoPath = TODO_PATH): TodoItem {
  const hasText = rawText !== undefined;
  const hasDue = rawDue !== undefined;
  if (!hasText && !hasDue) throw new Error('provide text and/or due to update');

  const document = readDocument(todoPath);
  const lines = document.split('\n');
  const found = findMatch(lines, rawMatch, false);
  const text = hasText ? validateText(rawText, 'text') : found.item.text;
  const clearDue =
    hasDue &&
    (rawDue === null ||
      (typeof rawDue === 'string' && (rawDue.trim() === '' || rawDue.trim().toLowerCase() === 'none')));
  const due = clearDue ? null : hasDue ? validateDue(rawDue) : found.item.due;

  const duplicate = lines.some((line, index) => {
    if (index === found.index) return false;
    const item = parseLine(line);
    return item !== null && !item.completed && item.text.toLocaleLowerCase() === text.toLocaleLowerCase();
  });
  if (duplicate) throw new Error(`active to-do already exists: ${text}`);

  lines[found.index] = `- [ ] ${text}${due ? ` 📅 ${due}` : ''}`;
  atomicWrite(todoPath, lines.join('\n'));
  return { text, completed: false, due };
}

export function completeTodo(rawMatch: unknown, todoPath = TODO_PATH): TodoItem {
  const document = readDocument(todoPath);
  const lines = document.split('\n');
  const found = findMatch(lines, rawMatch, false);
  const completed = { ...found.item, completed: true };
  lines.splice(found.index, 1);
  const doneIndex = lines.indexOf('## Done');
  if (doneIndex < 0) throw new Error('to-do list is missing the Done section');
  lines.splice(doneIndex + 1, 0, '', `- [x] ${completed.text}${completed.due ? ` 📅 ${completed.due}` : ''}`);
  atomicWrite(todoPath, lines.join('\n'));
  return completed;
}

export function removeTodo(rawMatch: unknown, todoPath = TODO_PATH): TodoItem {
  const document = readDocument(todoPath);
  const lines = document.split('\n');
  const found = findMatch(lines, rawMatch, false);
  lines.splice(found.index, 1);
  atomicWrite(todoPath, lines.join('\n'));
  return found.item;
}
