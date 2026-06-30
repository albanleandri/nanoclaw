import { describe, expect, it } from 'bun:test';

import { assertSupportedToolSchema, validateToolArguments } from './schema-validator.js';

const schema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    count: { type: 'number', minimum: 1, maximum: 3 },
  },
  required: ['text'],
};

describe('validateToolArguments', () => {
  it('accepts valid values', () => {
    expect(validateToolArguments(schema, { text: 'ok', count: 2 })).toEqual({ text: 'ok', count: 2 });
  });

  it('rejects missing, wrong-type, out-of-range, and unexpected values', () => {
    expect(() => validateToolArguments(schema, {})).toThrow(/text/);
    expect(() => validateToolArguments(schema, { text: 2 })).toThrow(/string/);
    expect(() => validateToolArguments(schema, { text: 'ok', count: 4 })).toThrow(/maximum/);
    expect(() => validateToolArguments(schema, { text: 'ok', extra: true })).toThrow(/unexpected/);
  });

  it('validates nested arrays, objects, enums, and integer bounds', () => {
    const nested = {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              count: { type: 'integer', minimum: 1, maximum: 3 },
              mode: { type: 'string', enum: ['safe'] },
            },
            required: ['count', 'mode'],
          },
        },
      },
      required: ['rows'],
    };
    expect(validateToolArguments(nested, { rows: [{ count: 2, mode: 'safe' }] })).toEqual({
      rows: [{ count: 2, mode: 'safe' }],
    });
    expect(() => validateToolArguments(nested, { rows: [{ count: 1.5, mode: 'safe' }] })).toThrow(/integer/);
    expect(() => validateToolArguments(nested, { rows: [{ count: 4, mode: 'safe' }] })).toThrow(/maximum/);
    expect(() => validateToolArguments(nested, { rows: [{ count: 2, mode: 'unsafe' }] })).toThrow(/enum/);
  });

  it('fails closed on unsupported schema assertions before execution', () => {
    expect(() =>
      assertSupportedToolSchema({
        type: 'object',
        properties: { text: { type: 'string', pattern: '^safe$' } },
      }),
    ).toThrow(/pattern/);
    expect(() => assertSupportedToolSchema({ oneOf: [{ type: 'string' }, { type: 'number' }] })).toThrow(/oneOf/);
    expect(() => assertSupportedToolSchema({ type: 'mystery' })).toThrow(/type/);
  });
});
