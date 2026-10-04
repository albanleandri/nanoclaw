/* eslint-disable preserve-caught-error -- protected input parser errors must be non-reflecting */
import { TextDecoder } from 'node:util';
import readline from 'node:readline';

import type { IntegrationCredentialSchema } from '../integrations/administration.js';
import { MAX_CREDENTIAL_FIELD_BYTES, MAX_CREDENTIAL_INPUT_BYTES } from './limits.js';

export interface CredentialWriteInvocation {
  action: 'set' | 'rotate';
  profile: string;
}

export function parseCredentialWriteInvocation(argv: readonly string[]): CredentialWriteInvocation | undefined {
  const positional: string[] = [];
  let forbiddenFlag = false;
  let help = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    if (arg === '--json') continue;
    if (arg === '--help') {
      help = true;
      continue;
    }
    forbiddenFlag = true;
    if (argv[index + 1] !== undefined && !argv[index + 1]!.startsWith('--')) index++;
  }

  if (positional[0] !== 'integrations' || positional[1] !== 'credential') return undefined;
  if (positional[2] !== 'set' && positional[2] !== 'rotate') return undefined;
  if (forbiddenFlag) throw new Error('Credential values cannot be supplied as command-line flags');
  if (help) return undefined;
  if (positional.length !== 4 || !positional[3]!.trim()) {
    throw new Error(`Usage: ncl integrations credential ${positional[2]} <profile> [--json]`);
  }
  return { action: positional[2], profile: positional[3]! };
}

export function parseCredentialSchema(value: unknown): IntegrationCredentialSchema {
  if (!isPlainRecord(value) || !Array.isArray(value.fields)) throw new Error('Host returned an invalid prompt schema');
  if (
    typeof value.profile_id !== 'string' ||
    typeof value.adapter_id !== 'string' ||
    !Number.isInteger(value.adapter_version)
  ) {
    throw new Error('Host returned an invalid prompt schema');
  }
  const names = new Set<string>();
  const fields = value.fields.map((candidate) => {
    if (
      !isPlainRecord(candidate) ||
      typeof candidate.name !== 'string' ||
      typeof candidate.label !== 'string' ||
      (candidate.sensitivity !== 'secret' && candidate.sensitivity !== 'private')
    ) {
      throw new Error('Host returned an invalid prompt schema');
    }
    const unsafeLabel = [...candidate.label].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127;
    });
    if (
      !/^[a-z][a-zA-Z0-9]*$/u.test(candidate.name) ||
      names.has(candidate.name) ||
      !candidate.label.trim() ||
      candidate.label.length > 80 ||
      unsafeLabel
    ) {
      throw new Error('Host returned an invalid prompt schema');
    }
    names.add(candidate.name);
    return {
      name: candidate.name,
      label: candidate.label,
      sensitivity: candidate.sensitivity as 'secret' | 'private',
    };
  });
  if (fields.length === 0) throw new Error('Host returned an invalid prompt schema');
  return {
    profile_id: value.profile_id,
    adapter_id: value.adapter_id,
    adapter_version: value.adapter_version as number,
    fields,
  };
}

export async function readCredentialJson(
  input: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
  maxBytes = MAX_CREDENTIAL_INPUT_BYTES,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new Error('Credential input exceeds the safe size limit');
    chunks.push(buffer);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error('Credential input must be UTF-8 JSON');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Credential input must contain exactly one JSON object');
  }
  if (!isPlainRecord(parsed)) throw new Error('Credential input must contain exactly one JSON object');
  return parsed;
}

export async function promptForCredential(
  schema: IntegrationCredentialSchema,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): Promise<Record<string, unknown>> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Interactive credential entry requires a controlling TTY');
  }
  const result: Record<string, unknown> = {};
  output.write('Enter protected integration values. Input is hidden.\n');
  for (const field of schema.fields) {
    output.write(`${field.label}: `);
    result[field.name] = await readHiddenLine(input, output);
    output.write('\n');
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_CREDENTIAL_INPUT_BYTES) {
      throw new Error('Credential input exceeds the safe size limit');
    }
  }
  return result;
}

async function readHiddenLine(input: NodeJS.ReadStream, output: NodeJS.WriteStream): Promise<string> {
  readline.emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  input.setRawMode(true);
  input.resume();

  return new Promise<string>((resolve, reject) => {
    let value = '';
    let bytes = 0;

    const cleanup = (): void => {
      input.removeListener('keypress', onKeypress);
      output.removeListener('error', onOutputError);
      input.setRawMode(Boolean(wasRaw));
      if (wasPaused) input.pause();
    };
    const onOutputError = (): void => {
      cleanup();
      reject(new Error('Credential prompt is unavailable'));
    };
    const onKeypress = (text: string, key: readline.Key): void => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('Credential entry cancelled'));
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(value);
        return;
      }
      if (key.name === 'backspace') {
        value = [...value].slice(0, -1).join('');
        bytes = Buffer.byteLength(value, 'utf8');
        return;
      }
      if (key.ctrl || key.meta || key.name === 'tab' || key.name === 'escape') return;
      if (!text || [...text].some((character) => character.codePointAt(0)! < 32)) return;
      const nextBytes = bytes + Buffer.byteLength(text, 'utf8');
      if (nextBytes > MAX_CREDENTIAL_FIELD_BYTES) {
        cleanup();
        reject(new Error('Credential field exceeds the safe size limit'));
        return;
      }
      value += text;
      bytes = nextBytes;
    };

    input.on('keypress', onKeypress);
    output.once('error', onOutputError);
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
/* eslint-enable preserve-caught-error */
