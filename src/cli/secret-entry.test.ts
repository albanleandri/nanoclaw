import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  parseCredentialSchema,
  parseCredentialWriteInvocation,
  promptForCredential,
  readCredentialJson,
} from './secret-entry.js';

describe('credential command parsing', () => {
  it('recognizes only set and rotate without accepting secret-valued flags', () => {
    expect(parseCredentialWriteInvocation(['integrations', 'credential', 'set', 'portal'])).toEqual({
      action: 'set',
      profile: 'portal',
    });
    expect(parseCredentialWriteInvocation(['integrations', 'credential', 'rotate', 'portal', '--json'])).toEqual({
      action: 'rotate',
      profile: 'portal',
    });
    expect(parseCredentialWriteInvocation(['integrations', 'credential', 'revoke', 'portal'])).toBeUndefined();
  });

  it('rejects command-line credential flags without echoing their names or values', () => {
    const sentinel = 'SENTINEL_ARG_SECRET';
    expect(() =>
      parseCredentialWriteInvocation(['integrations', 'credential', 'set', 'portal', '--password', sentinel]),
    ).toThrow('Credential values cannot be supplied as command-line flags');
    /* eslint-disable no-catch-all/no-catch-all -- test inspects the deliberately sanitized boundary error */
    try {
      parseCredentialWriteInvocation(['integrations', 'credential', 'set', 'portal', '--password', sentinel]);
    } catch (error) {
      expect(String(error)).not.toContain(sentinel);
      expect(String(error)).not.toContain('password');
    }
    /* eslint-enable no-catch-all/no-catch-all */
  });
});

describe('non-interactive credential input', () => {
  it('accepts exactly one bounded JSON object', async () => {
    await expect(readCredentialJson([' {"username":"u","password":"p"}\n '])).resolves.toEqual({
      username: 'u',
      password: 'p',
    });
    await expect(readCredentialJson(['{}\n{}'])).rejects.toThrow(/exactly one JSON object/);
    await expect(readCredentialJson(['[]'])).rejects.toThrow(/exactly one JSON object/);
    await expect(readCredentialJson(['{"value":"too-large"}'], 4)).rejects.toThrow(/size limit/);
  });

  it('validates host-provided prompt metadata', () => {
    expect(
      parseCredentialSchema({
        profile_id: 'profile-1',
        adapter_id: 'test',
        adapter_version: 1,
        fields: [{ name: 'password', label: 'Password', sensitivity: 'secret' }],
      }),
    ).toMatchObject({ profile_id: 'profile-1' });
    expect(() => parseCredentialSchema({ fields: [] })).toThrow(/invalid prompt schema/);
    expect(() =>
      parseCredentialSchema({
        profile_id: 'profile-1',
        adapter_id: 'test',
        adapter_version: 1,
        fields: [{ name: 'password', label: 'Password\u001b[2J', sensitivity: 'secret' }],
      }),
    ).toThrow(/invalid prompt schema/);
  });
});

describe('interactive credential input', () => {
  it('does not echo protected values to the terminal', async () => {
    const sentinel = 'SENTINEL_TTY_SECRET';
    const input = new PassThrough() as PassThrough & NodeJS.ReadStream;
    const output = new PassThrough() as PassThrough & NodeJS.WriteStream;
    Object.assign(input, { isTTY: true, isRaw: false, setRawMode: () => input });
    Object.assign(output, { isTTY: true });
    let rendered = '';
    output.on('data', (chunk) => {
      rendered += chunk.toString('utf8');
    });

    const pending = promptForCredential(
      {
        profile_id: 'profile-1',
        adapter_id: 'test',
        adapter_version: 1,
        fields: [{ name: 'password', label: 'Password', sensitivity: 'secret' }],
      },
      input,
      output,
    );
    input.write(`${sentinel}\r`);

    await expect(pending).resolves.toEqual({ password: sentinel });
    expect(rendered).toContain('Password:');
    expect(rendered).not.toContain(sentinel);
  });
});
