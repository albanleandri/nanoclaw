/**
 * Tool-boundary validation for install_packages / add_mcp_server. The host
 * re-validates (defense in depth), but this layer is what stops a shell
 * fragment such as `curl;rm` from ever being written to the outbox as an
 * apt package name. Losing these checks would leave only the host check
 * between an agent and a root `apt-get install` line in a Dockerfile.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { addMcpServer, installPackages } from './self-mod.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function systemRows(): Array<Record<string, unknown>> {
  return getUndeliveredMessages()
    .filter((m) => m.kind === 'system')
    .map((m) => JSON.parse(m.content) as Record<string, unknown>);
}

function text(result: Awaited<ReturnType<typeof installPackages.handler>>): string {
  return (result as { content: Array<{ text: string }> }).content[0].text;
}

describe('install_packages', () => {
  it('writes one system request for valid apt and npm names', async () => {
    const result = await installPackages.handler({
      apt: ['ffmpeg', 'libc6-dev'],
      npm: ['@scope/pkg', 'lodash'],
      reason: 'video',
    });
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    expect(systemRows()).toEqual([
      { action: 'install_packages', apt: ['ffmpeg', 'libc6-dev'], npm: ['@scope/pkg', 'lodash'], reason: 'video' },
    ]);
  });

  it('rejects an empty request', async () => {
    const result = await installPackages.handler({});
    expect(text(result)).toContain('At least one apt or npm package');
    expect(systemRows()).toEqual([]);
  });

  it('caps the number of packages per request', async () => {
    const result = await installPackages.handler({ apt: Array.from({ length: 21 }, (_, i) => `pkg${i}`) });
    expect(text(result)).toContain('Maximum 20 packages');
    expect(systemRows()).toEqual([]);
  });

  it.each([
    ['apt', 'curl;rm -rf /'],
    ['apt', 'Uppercase'],
    ['apt', '--allow-unauthenticated'],
    ['npm', 'lodash@4.17.0'],
    ['npm', '$(whoami)'],
  ])('rejects an unsafe %s name: %s', async (field, name) => {
    const result = await installPackages.handler({ [field]: [name] });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toContain(`Invalid ${field} package name`);
    expect(systemRows()).toEqual([]);
  });
});

describe('add_mcp_server', () => {
  it('requires a name and a command', async () => {
    const result = await addMcpServer.handler({ name: 'gh' });
    expect(text(result)).toContain('name and command are required');
    expect(systemRows()).toEqual([]);
  });

  it('writes the request with defaulted args and env', async () => {
    await addMcpServer.handler({ name: 'gh', command: 'npx' });
    expect(systemRows()).toEqual([{ action: 'add_mcp_server', name: 'gh', command: 'npx', args: [], env: {} }]);
  });
});
