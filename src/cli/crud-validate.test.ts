import { describe, expect, it } from 'vitest';

import { dispatch } from './dispatch.js';
import { validateArgs, registerResource, type ColumnDef } from './crud.js';

const defs: ColumnDef[] = [
  { name: 'prompt', type: 'string', description: 'p', required: true },
  { name: 'count', type: 'number', description: 'c' },
  { name: 'force', type: 'boolean', description: 'f' },
  { name: 'meta', type: 'json', description: 'm' },
  { name: 'status', type: 'string', description: 's', enum: ['pending', 'paused'] },
  { name: 'limit', type: 'number', description: 'l', default: 200 },
];

describe('validateArgs', () => {
  it('rejects an unknown flag by its hyphenated name', () => {
    expect(() => validateArgs(defs, { prompt: 'x', bad_flag: '1' })).toThrow('unknown flag --bad-flag');
  });

  it('rejects a missing required flag', () => {
    expect(() => validateArgs(defs, {})).toThrow('--prompt is required');
  });

  it('coerces a numeric string and rejects a non-number', () => {
    expect(validateArgs(defs, { prompt: 'x', count: '7' }).count).toBe(7);
    expect(() => validateArgs(defs, { prompt: 'x', count: 'abc' })).toThrow('--count must be a number, got "abc"');
  });

  it('coerces boolean forms and rejects garbage', () => {
    expect(validateArgs(defs, { prompt: 'x', force: 'true' }).force).toBe(true);
    expect(validateArgs(defs, { prompt: 'x', force: '0' }).force).toBe(false);
    expect(() => validateArgs(defs, { prompt: 'x', force: 'maybe' })).toThrow('--force must be true or false');
  });

  it('parses json and rejects malformed json', () => {
    expect(validateArgs(defs, { prompt: 'x', meta: '{"a":1}' }).meta).toEqual({ a: 1 });
    expect(() => validateArgs(defs, { prompt: 'x', meta: '{' })).toThrow('--meta must be valid JSON');
  });

  it('rejects a value outside the declared enum', () => {
    expect(() => validateArgs(defs, { prompt: 'x', status: 'done' })).toThrow(
      '--status must be one of: pending, paused',
    );
  });

  it('rejects a value-less flag on a non-boolean', () => {
    expect(() => validateArgs(defs, { prompt: true })).toThrow('--prompt requires a value');
  });

  it('applies declared defaults for omitted flags', () => {
    expect(validateArgs(defs, { prompt: 'x' }).limit).toBe(200);
  });

  it('tolerates the dispatcher-injected group-scope keys', () => {
    // Regression: group-scope auto-fill puts id/agent_group_id/group into
    // req.args before parseArgs runs. Rejecting them breaks every scoped
    // agent call.
    expect(() => validateArgs(defs, { prompt: 'x', id: 'a', agent_group_id: 'b', group: 'c' })).not.toThrow();
  });

  it('appends the verb usage block to a validation failure', async () => {
    registerResource({
      name: 'widget',
      plural: 'widgets',
      table: 'widgets',
      description: 'widget',
      idColumn: 'id',
      columns: [{ name: 'id', type: 'string', description: 'id' }],
      operations: {},
      customOperations: {
        make: {
          access: 'open',
          description: 'Make a widget.',
          args: [{ name: 'size', type: 'string', description: 'Widget size.', required: true }],
          handler: async () => ({}),
        },
      },
    });
    const res = await dispatch({ id: 'v1', command: 'widgets-make', args: {} }, { caller: 'host' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('invalid-args');
    expect(!res.ok && res.error.message).toContain('--size is required');
    expect(!res.ok && res.error.message).toContain('ncl widgets make');
    expect(!res.ok && res.error.message).toContain('Widget size.');
  });
});
