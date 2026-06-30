type Schema = Record<string, any>;

const ALLOWED_SCHEMA_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'items',
  'minimum',
  'maximum',
  'description',
  'title',
  'default',
]);
const ALLOWED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);

function assertSchema(schema: unknown, path: string): asserts schema is Schema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`${path} must be an object`);
  const typed = schema as Schema;
  for (const keyword of Object.keys(typed)) {
    if (!ALLOWED_SCHEMA_KEYWORDS.has(keyword)) throw new Error(`${path} uses unsupported keyword ${keyword}`);
  }
  if (typed.type !== undefined && !ALLOWED_TYPES.has(typed.type)) {
    throw new Error(`${path}.type is unsupported: ${String(typed.type)}`);
  }
  if (typed.enum !== undefined && !Array.isArray(typed.enum)) throw new Error(`${path}.enum must be an array`);
  if (typed.required !== undefined && !Array.isArray(typed.required))
    throw new Error(`${path}.required must be an array`);
  if (typed.additionalProperties !== undefined && typeof typed.additionalProperties !== 'boolean') {
    throw new Error(`${path}.additionalProperties must be boolean`);
  }
  if (typed.properties !== undefined) {
    if (!typed.properties || typeof typed.properties !== 'object' || Array.isArray(typed.properties)) {
      throw new Error(`${path}.properties must be an object`);
    }
    for (const [name, child] of Object.entries(typed.properties)) assertSchema(child, `${path}.properties.${name}`);
  }
  if (typed.items !== undefined) assertSchema(typed.items, `${path}.items`);
}

export function assertSupportedToolSchema(schema: Record<string, unknown>): void {
  assertSchema(schema, 'schema');
  if (schema.type !== 'object') throw new Error('schema.type must be object');
}

function validate(schema: Schema, value: unknown, path: string): unknown {
  if (schema.enum && !schema.enum.some((item: unknown) => Object.is(item, value))) {
    throw new Error(`${path} must be one of the declared enum values`);
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
    const input = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const name of schema.required ?? []) {
      if (!(name in input)) throw new Error(`${path}.${name} is required`);
    }
    for (const name of Object.keys(input)) {
      if (!(name in properties)) {
        if (schema.additionalProperties === true) continue;
        throw new Error(`${path}.${name} is unexpected`);
      }
      validate(properties[name], input[name], `${path}.${name}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    value.forEach((item, index) => validate(schema.items ?? {}, item, `${path}[${index}]`));
  } else if (schema.type === 'string' && typeof value !== 'string') {
    throw new Error(`${path} must be a string`);
  } else if (schema.type === 'number' && typeof value !== 'number') {
    throw new Error(`${path} must be a number`);
  } else if (schema.type === 'integer' && (!Number.isInteger(value) || typeof value !== 'number')) {
    throw new Error(`${path} must be an integer`);
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') {
    throw new Error(`${path} must be a boolean`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path} is below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path} exceeds maximum`);
  }
  return value;
}

export function validateToolArguments(schema: Record<string, unknown>, value: unknown): Record<string, unknown> {
  assertSupportedToolSchema(schema);
  return validate(schema, value, 'arguments') as Record<string, unknown>;
}
