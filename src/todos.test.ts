import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addTodo, completeTodo, listTodos, removeTodo } from './todos.js';

const TEMPLATE = `# Todo List

## Active

- [ ] Alpha task
- [ ] Beta task 📅 2026-09-30

## Done

- [x] Old task
`;

describe('host-managed todos', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-todos-'));
    file = path.join(dir, 'TODO.md');
    fs.writeFileSync(file, TEMPLATE);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists active and completed items with due dates', () => {
    expect(listTodos(file)).toEqual([
      { text: 'Alpha task', completed: false, due: null },
      { text: 'Beta task', completed: false, due: '2026-09-30' },
      { text: 'Old task', completed: true, due: null },
    ]);
  });

  it('adds an item atomically below Active and rejects duplicates', () => {
    const originalMode = fs.statSync(file).mode & 0o777;
    expect(addTodo('Gamma task', '2026-10-01', file)).toEqual({
      text: 'Gamma task',
      completed: false,
      due: '2026-10-01',
    });
    expect(fs.readFileSync(file, 'utf8')).toContain('## Active\n\n- [ ] Gamma task 📅 2026-10-01');
    expect(fs.statSync(file).mode & 0o777).toBe(originalMode);
    expect(() => addTodo('gamma TASK', undefined, file)).toThrow(/already exists/);
  });

  it('moves one uniquely matched active item to Done', () => {
    expect(completeTodo('beta', file)).toEqual({ text: 'Beta task', completed: true, due: '2026-09-30' });
    const content = fs.readFileSync(file, 'utf8');
    expect(content).not.toContain('- [ ] Beta task');
    expect(content).toContain('## Done\n\n- [x] Beta task 📅 2026-09-30');
  });

  it('removes one uniquely matched active item and rejects ambiguous matches', () => {
    expect(() => removeTodo('task', file)).toThrow(/ambiguous/);
    expect(removeTodo('alpha', file)).toEqual({ text: 'Alpha task', completed: false, due: null });
    expect(fs.readFileSync(file, 'utf8')).not.toContain('Alpha task');
  });

  it('rejects multiline text and invalid dates', () => {
    expect(() => addTodo('bad\nitem', undefined, file)).toThrow(/single line/);
    expect(() => addTodo('bad date', '2026-02-30', file)).toThrow(/valid calendar date/);
  });
});
