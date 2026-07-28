import { describe, expect, it } from 'vitest';

import type { ResourceDef } from './crud.js';
import { listVerbs, renderVerbHelp, summaryLine } from './help-render.js';

const res: ResourceDef = {
  name: 'task',
  plural: 'tasks',
  table: 'messages_in',
  description: 'Scheduled task.',
  idColumn: 'series_id',
  columns: [{ name: 'series_id', type: 'string', description: 'Handle.', generated: true }],
  operations: {},
  customOperations: {
    create: {
      access: 'open',
      description: 'Create a task.\n\nLong form explanation.',
      args: [
        { name: 'prompt', type: 'string', description: 'Task prompt.', required: true },
        { name: 'status', type: 'string', description: 'Live state.', enum: ['pending', 'paused'] },
      ],
      examples: ['ncl tasks create --prompt "hi"'],
      handler: async () => ({}),
    },
  },
};

describe('summaryLine', () => {
  it('returns only the first line of a multi-paragraph description', () => {
    expect(summaryLine('Create a task.\n\nLong form explanation.')).toBe('Create a task.');
  });
});

describe('listVerbs', () => {
  it('lists custom operation keys', () => {
    expect(listVerbs(res)).toEqual(['create']);
  });
});

describe('renderVerbHelp', () => {
  it('renders usage, full description, flags with tags, and examples', () => {
    const out = renderVerbHelp(res, 'create')!;
    expect(out).toContain('ncl tasks create');
    expect(out).toContain('Long form explanation.');
    expect(out).toContain('--prompt');
    expect(out).toContain('(required)');
    expect(out).toContain('values: pending | paused');
    expect(out).toContain('ncl tasks create --prompt "hi"');
  });

  it('returns undefined for a verb the resource does not have', () => {
    expect(renderVerbHelp(res, 'nope')).toBeUndefined();
  });
});
