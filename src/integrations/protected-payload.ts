import type { HostIntegrationAdapter, ProtectedField } from './types.js';

const FIELD_NAME = /^[a-z][a-zA-Z0-9]*$/;

export function validateProtectedFieldDeclarations(fields: readonly ProtectedField[]): void {
  if (fields.length === 0) throw new Error('Host integration must declare at least one protected field');

  const names = new Set<string>();
  for (const field of fields) {
    if (!FIELD_NAME.test(field.name)) {
      throw new Error(`Invalid protected field name: ${field.name || '(empty)'}`);
    }
    if (names.has(field.name)) throw new Error(`Protected field is declared twice: ${field.name}`);
    names.add(field.name);
    if (field.sensitivity !== 'secret' && field.sensitivity !== 'private') {
      throw new Error(`Invalid sensitivity for protected field ${field.name}`);
    }
    const hasUnsafeLabelCharacter = [...field.label].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127;
    });
    if (!field.label.trim() || field.label.length > 80 || hasUnsafeLabelCharacter) {
      throw new Error(`Protected field ${field.name} must have a safe label`);
    }
  }
}

/**
 * Run the adapter schema and prove that every top-level protected value has an
 * explicit sensitivity classification. The payload stays host-internal; this
 * helper deliberately returns no values other than the validated payload.
 */
export function validateAndClassifyProtectedPayload<Config extends object, ProtectedPayload extends object>(
  adapter: HostIntegrationAdapter<Config, ProtectedPayload>,
  value: unknown,
): ProtectedPayload {
  validateProtectedFieldDeclarations(adapter.protectedFields);
  const payload = adapter.validateProtectedPayload(value);
  if (!isPlainRecord(payload)) {
    throw new Error(`Host integration ${adapter.id} protected payload validator must return a plain object`);
  }

  const declared = new Set(adapter.protectedFields.map((field) => field.name));
  const ownKeys = Reflect.ownKeys(payload);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new Error(`Host integration ${adapter.id} returned symbol-keyed protected fields`);
  }
  const actual = ownKeys as string[];
  const unclassified = actual.filter((name) => !declared.has(name));
  if (unclassified.length > 0) {
    throw new Error(`Host integration ${adapter.id} returned unclassified protected fields`);
  }
  const missing = [...declared].filter((name) => !Object.prototype.hasOwnProperty.call(payload, name));
  if (missing.length > 0) {
    throw new Error(`Host integration ${adapter.id} did not return every declared protected field`);
  }
  return payload;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
