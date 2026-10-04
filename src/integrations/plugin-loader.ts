/* eslint-disable preserve-caught-error -- plugin failures must stop startup without reflecting module internals */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DATA_DIR } from '../config.js';
import type { IntegrationProfileRow } from '../types.js';
import {
  createHostIntegrationPluginRuntime,
  registerHostIntegrationRenderer,
  type HostIntegrationPlugin,
  type HostIntegrationPluginModule,
  type HostIntegrationRendererRegistry,
} from './plugin.js';
import {
  registerHostIntegrationAdapter,
  requireHostIntegrationAdapter,
  type HostIntegrationRegistry,
} from './registry.js';

const MANIFEST_VERSION = 1;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PLUGINS = 32;
const PLUGIN_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const HOST_INTEGRATION_PLUGIN_MANIFEST = path.join(DATA_DIR, 'host-integrations', 'plugins.json');

interface ManifestEntry {
  name: string;
  modulePath: string;
  sha256: string;
}

interface PluginManifest {
  version: 1;
  plugins: ManifestEntry[];
}

type RegistryWriter = Pick<HostIntegrationRegistry, 'register' | 'require'>;
type ModuleImporter = (modulePath: string) => Promise<unknown>;

export interface LoadHostIntegrationPluginsOptions {
  manifestPath?: string;
  registry?: RegistryWriter;
  rendererRegistry?: HostIntegrationRendererRegistry;
  importer?: ModuleImporter;
  allowMissingManifest?: boolean;
}

const defaultRegistry: RegistryWriter = {
  register: registerHostIntegrationAdapter,
  require: requireHostIntegrationAdapter,
};
const defaultRendererRegistry: HostIntegrationRendererRegistry = {
  register: registerHostIntegrationRenderer,
  get: () => undefined,
};

export async function loadHostIntegrationPlugins(options: LoadHostIntegrationPluginsOptions = {}): Promise<number> {
  const manifestPath = options.manifestPath ?? HOST_INTEGRATION_PLUGIN_MANIFEST;
  const allowMissing = options.allowMissingManifest ?? true;
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readSafeFile(manifestPath, MAX_MANIFEST_BYTES);
  } catch (error) {
    if (allowMissing && isMissing(error)) return 0;
    throw new Error('Host integration plugin manifest is unavailable.');
  }
  const manifest = parseManifest(manifestBytes);
  const registry = options.registry ?? defaultRegistry;
  const renderers = options.rendererRegistry ?? defaultRendererRegistry;
  const importer = options.importer ?? importPluginModule;
  const runtime = createHostIntegrationPluginRuntime();

  for (const entry of manifest.plugins) {
    const moduleBytes = await readSafeFile(entry.modulePath, 16 * 1024 * 1024);
    if (createHash('sha256').update(moduleBytes).digest('hex') !== entry.sha256) {
      throw new Error('Host integration plugin digest mismatch.');
    }
    let imported: unknown;
    try {
      imported = await importer(entry.modulePath);
    } catch {
      throw new Error('Host integration plugin could not be loaded.');
    }
    const module = validateModule(imported);
    let plugin: HostIntegrationPlugin;
    try {
      plugin = await module.createHostIntegrationPlugin(runtime);
    } catch {
      throw new Error('Host integration plugin initialization failed.');
    }
    validatePlugin(entry.name, plugin);
    for (const adapter of plugin.adapters) registry.register(adapter);
    for (const renderer of plugin.renderers ?? []) {
      const adapter = plugin.adapters.find(
        (candidate) => candidate.id === renderer.adapterId && candidate.version === renderer.adapterVersion,
      );
      if (!adapter || !Object.prototype.hasOwnProperty.call(adapter.operations, renderer.operation)) {
        throw new Error('Host integration plugin renderer target is invalid.');
      }
      renderers.register(renderer);
    }
  }
  return manifest.plugins.length;
}

export function assertEnabledIntegrationPluginsAvailable(
  rows: readonly IntegrationProfileRow[],
  registry: Pick<HostIntegrationRegistry, 'require'> = defaultRegistry,
): void {
  for (const row of rows) {
    if (row.enabled !== 1) continue;
    try {
      registry.require(row.adapter_id, row.adapter_version);
    } catch {
      throw new Error('An enabled host integration profile requires an unavailable plugin.');
    }
  }
}

async function readSafeFile(filePath: string, maximumBytes: number): Promise<Buffer> {
  if (!path.isAbsolute(filePath)) throw new Error('Host integration plugin paths must be absolute.');
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximumBytes) {
    throw new Error('Host integration plugin file is unsafe.');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('Host integration plugin file owner is unsafe.');
  }
  if ((stat.mode & 0o022) !== 0) throw new Error('Host integration plugin file permissions are unsafe.');
  if ((await realpath(filePath)) !== path.resolve(filePath)) throw new Error('Host integration plugin path is unsafe.');
  return readFile(filePath);
}

function parseManifest(bytes: Buffer): PluginManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('Host integration plugin manifest is invalid.');
  }
  const root = exactRecord(value, ['version', 'plugins']);
  if (root.version !== MANIFEST_VERSION || !Array.isArray(root.plugins) || root.plugins.length > MAX_PLUGINS) {
    throw new Error('Host integration plugin manifest is invalid.');
  }
  const names = new Set<string>();
  const modulePaths = new Set<string>();
  const plugins = root.plugins.map((candidate) => {
    const entry = exactRecord(candidate, ['name', 'modulePath', 'sha256']);
    if (
      typeof entry.name !== 'string' ||
      !PLUGIN_NAME.test(entry.name) ||
      typeof entry.modulePath !== 'string' ||
      !path.isAbsolute(entry.modulePath) ||
      typeof entry.sha256 !== 'string' ||
      !SHA256.test(entry.sha256)
    ) {
      throw new Error('Host integration plugin manifest is invalid.');
    }
    if (names.has(entry.name) || modulePaths.has(entry.modulePath)) {
      throw new Error('Host integration plugin manifest contains a duplicate.');
    }
    names.add(entry.name);
    modulePaths.add(entry.modulePath);
    return { name: entry.name, modulePath: entry.modulePath, sha256: entry.sha256 };
  });
  return { version: 1, plugins };
}

function validateModule(value: unknown): HostIntegrationPluginModule {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as HostIntegrationPluginModule).createHostIntegrationPlugin !== 'function'
  ) {
    throw new Error('Host integration plugin module is invalid.');
  }
  return value as HostIntegrationPluginModule;
}

function validatePlugin(expectedName: string, plugin: HostIntegrationPlugin): void {
  if (
    !plugin ||
    typeof plugin !== 'object' ||
    plugin.apiVersion !== 1 ||
    plugin.name !== expectedName ||
    !Array.isArray(plugin.adapters) ||
    plugin.adapters.length === 0 ||
    (plugin.renderers !== undefined && !Array.isArray(plugin.renderers))
  ) {
    throw new Error('Host integration plugin declaration is invalid.');
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Host integration plugin manifest is invalid.');
  }
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== 'string') || actual.length !== keys.length) {
    throw new Error('Host integration plugin manifest is invalid.');
  }
  const sorted = (actual as string[]).sort();
  const expected = [...keys].sort();
  if (sorted.some((key, index) => key !== expected[index])) {
    throw new Error('Host integration plugin manifest is invalid.');
  }
  return value as Record<string, unknown>;
}

async function importPluginModule(modulePath: string): Promise<unknown> {
  return import(pathToFileURL(modulePath).href);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
/* eslint-enable preserve-caught-error */
