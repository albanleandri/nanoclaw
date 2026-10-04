import { createHash } from 'node:crypto';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { IntegrationProfileRow } from '../types.js';
import { assertEnabledIntegrationPluginsAvailable, loadHostIntegrationPlugins } from './plugin-loader.js';
import { createHostIntegrationRendererRegistry } from './plugin.js';
import { createHostIntegrationRegistry } from './registry.js';
import type { HostIntegrationAdapter } from './types.js';

function adapter(): HostIntegrationAdapter<{ scope: string }, { token: string }> {
  return {
    id: 'synthetic-records',
    version: 1,
    securityTier: 'trusted-host',
    hostAuthJustification: 'Synthetic form-session test adapter.',
    validateConfig: (value) => value as { scope: string },
    validateProtectedPayload: (value) => value as { token: string },
    protectedFields: [{ name: 'token', sensitivity: 'secret', label: 'Synthetic token' }],
    operations: {
      'records.read': {
        name: 'records.read',
        sideEffects: 'none',
        validateInput: (value) => value,
        validateOutput: (value) => value,
        totalDeadlineMs: 1_000,
        network: {
          destinations: [
            {
              origin: 'https://records.example.test',
              methods: ['GET'],
              isAllowedUrl: (url) => url.origin === 'https://records.example.test' && url.pathname === '/records',
            },
          ],
          maxRedirects: 0,
          requestDeadlineMs: 500,
          maxCookies: 4,
          retry: { methods: [], statuses: [], maxAttempts: 1, maxRetryAfterMs: 0 },
        },
        responseLimits: {
          maxHeaderBytes: 1_024,
          maxCookieBytes: 1_024,
          maxBodyBytes: 1_024,
          maxNormalizedOutputBytes: 1_024,
        },
        execute: async () => ({ records: [] }),
      },
    },
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nanoclaw-plugin-'));
  const modulePath = path.join(directory, 'plugin.mjs');
  const moduleBytes = Buffer.from('export const placeholder = true;\n');
  await writeFile(modulePath, moduleBytes, { mode: 0o600 });
  const sha256 = createHash('sha256').update(moduleBytes).digest('hex');
  const manifestPath = path.join(directory, 'plugins.json');
  const writeManifest = async (value: unknown) => {
    await writeFile(manifestPath, JSON.stringify(value), { mode: 0o600 });
  };
  await writeManifest({ version: 1, plugins: [{ name: 'synthetic-private', modulePath, sha256 }] });
  return { manifestPath, modulePath, sha256, writeManifest };
}

describe('host integration plugin loader', () => {
  it('loads a hash-pinned plugin and registers only its declared adapter and renderer', async () => {
    const files = await fixture();
    const registry = createHostIntegrationRegistry();
    const renderers = createHostIntegrationRendererRegistry();
    const count = await loadHostIntegrationPlugins({
      manifestPath: files.manifestPath,
      allowMissingManifest: false,
      registry,
      rendererRegistry: renderers,
      importer: async (modulePath) => {
        expect(modulePath).toBe(files.modulePath);
        return {
          createHostIntegrationPlugin: () => ({
            apiVersion: 1,
            name: 'synthetic-private',
            adapters: [adapter()],
            renderers: [
              {
                adapterId: 'synthetic-records',
                adapterVersion: 1,
                operation: 'records.read',
                render: () => 'synthetic output',
              },
            ],
          }),
        };
      },
    });
    expect(count).toBe(1);
    expect(registry.require('synthetic-records', 1).id).toBe('synthetic-records');
    expect(renderers.get('synthetic-records', 1, 'records.read')?.render({} as never)).toBe('synthetic output');
  });

  it('fails closed on missing, duplicate, drifted, or writable plugin state', async () => {
    const missing = path.join(await mkdtemp(path.join(os.tmpdir(), 'nanoclaw-plugin-missing-')), 'none.json');
    await expect(loadHostIntegrationPlugins({ manifestPath: missing, allowMissingManifest: false })).rejects.toThrow(
      /manifest is unavailable/,
    );

    const files = await fixture();
    await files.writeManifest({
      version: 1,
      plugins: [
        { name: 'synthetic-private', modulePath: files.modulePath, sha256: files.sha256 },
        { name: 'synthetic-private', modulePath: files.modulePath + '.other', sha256: files.sha256 },
      ],
    });
    await expect(loadHostIntegrationPlugins({ manifestPath: files.manifestPath })).rejects.toThrow(/duplicate/);

    await files.writeManifest({
      version: 1,
      plugins: [{ name: 'synthetic-private', modulePath: files.modulePath, sha256: '0'.repeat(64) }],
    });
    await expect(loadHostIntegrationPlugins({ manifestPath: files.manifestPath })).rejects.toThrow(/digest mismatch/);

    await chmod(files.modulePath, 0o622);
    await files.writeManifest({
      version: 1,
      plugins: [{ name: 'synthetic-private', modulePath: files.modulePath, sha256: files.sha256 }],
    });
    await expect(loadHostIntegrationPlugins({ manifestPath: files.manifestPath })).rejects.toThrow(/unsafe/);
  });

  it('rejects renderer targets outside the plugin and enabled profiles with unavailable adapters', async () => {
    const files = await fixture();
    await expect(
      loadHostIntegrationPlugins({
        manifestPath: files.manifestPath,
        allowMissingManifest: false,
        registry: createHostIntegrationRegistry(),
        rendererRegistry: createHostIntegrationRendererRegistry(),
        importer: async () => ({
          createHostIntegrationPlugin: () => ({
            apiVersion: 1,
            name: 'synthetic-private',
            adapters: [adapter()],
            renderers: [{ adapterId: 'other', adapterVersion: 1, operation: 'records.read', render: () => 'bad' }],
          }),
        }),
      }),
    ).rejects.toThrow(/renderer target/);

    const row = {
      enabled: 1,
      adapter_id: 'missing-private',
      adapter_version: 1,
    } as IntegrationProfileRow;
    expect(() => assertEnabledIntegrationPluginsAvailable([row], createHostIntegrationRegistry())).toThrow(
      /requires an unavailable plugin/,
    );
  });
});
