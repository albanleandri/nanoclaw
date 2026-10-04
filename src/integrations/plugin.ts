import type { IntegrationInvocationFailureClass } from '../db/integration-invocations.js';
import type { HostIntegrationInvocationResult } from './invoker.js';
import { HostIntegrationOperationError } from './invoker.js';
import { createBoundedHostHttpSession, type BoundedHostHttpSessionOptions } from './http-session.js';
import type { HostIntegrationAdapter, HostIntegrationOperation } from './types.js';

export interface HostIntegrationHumanRenderer {
  adapterId: string;
  adapterVersion: number;
  operation: string;
  render(result: HostIntegrationInvocationResult): string;
}

export interface HostIntegrationPlugin {
  apiVersion: 1;
  name: string;
  adapters: readonly HostIntegrationAdapter<object, object>[];
  renderers?: readonly HostIntegrationHumanRenderer[];
}

export interface HostIntegrationPluginRuntime {
  createHttpSession<Config extends object>(
    options: BoundedHostHttpSessionOptions<Config>,
  ): ReturnType<typeof createBoundedHostHttpSession<Config>>;
  operationError(resultClass: IntegrationInvocationFailureClass): HostIntegrationOperationError;
}

export interface HostIntegrationPluginModule {
  createHostIntegrationPlugin(
    runtime: HostIntegrationPluginRuntime,
  ): HostIntegrationPlugin | Promise<HostIntegrationPlugin>;
}

export function createHostIntegrationPluginRuntime(): HostIntegrationPluginRuntime {
  return Object.freeze({
    createHttpSession: createBoundedHostHttpSession,
    operationError: (resultClass: IntegrationInvocationFailureClass) => new HostIntegrationOperationError(resultClass),
  });
}

export interface HostIntegrationRendererRegistry {
  register(renderer: HostIntegrationHumanRenderer): void;
  get(adapterId: string, adapterVersion: number, operation: string): HostIntegrationHumanRenderer | undefined;
}

export function createHostIntegrationRendererRegistry(): HostIntegrationRendererRegistry {
  const renderers = new Map<string, HostIntegrationHumanRenderer>();
  return {
    register(renderer) {
      validateRenderer(renderer);
      const key = rendererKey(renderer.adapterId, renderer.adapterVersion, renderer.operation);
      if (renderers.has(key)) throw new Error('Host integration renderer is already registered');
      renderers.set(key, Object.freeze({ ...renderer }));
    },
    get: (adapterId, adapterVersion, operation) => renderers.get(rendererKey(adapterId, adapterVersion, operation)),
  };
}

function validateRenderer(renderer: HostIntegrationHumanRenderer): void {
  if (
    !renderer.adapterId ||
    !Number.isInteger(renderer.adapterVersion) ||
    renderer.adapterVersion < 1 ||
    !renderer.operation ||
    typeof renderer.render !== 'function'
  ) {
    throw new Error('Host integration renderer declaration is invalid');
  }
}

function rendererKey(adapterId: string, adapterVersion: number, operation: string): string {
  return `${adapterId}@${adapterVersion}.${operation}`;
}

const defaultRendererRegistry = createHostIntegrationRendererRegistry();

export const registerHostIntegrationRenderer = defaultRendererRegistry.register;
export const getHostIntegrationRenderer = defaultRendererRegistry.get;

export function renderHostIntegrationResult(result: HostIntegrationInvocationResult): string {
  const renderer = getHostIntegrationRenderer(result.adapter.id, result.adapter.version, result.operation);
  if (!renderer) return JSON.stringify(result.data, null, 2);
  try {
    const rendered = renderer.render(result);
    if (typeof rendered !== 'string' || !rendered.trim() || Buffer.byteLength(rendered, 'utf8') > 256 * 1024) {
      throw new Error('invalid renderer output');
    }
    return rendered;
  } catch {
    // Renderer exceptions may contain private normalized values. Never attach
    // them as a cause to the stable presentation error.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('Integration result rendering failed.');
  }
}

export type PluginOperation = HostIntegrationOperation<object, object>;
