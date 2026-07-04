import { describe, expect, it, vi } from 'vitest';

import { compileEffectiveSessionPlan } from './capabilities/compile-session-plan.js';
import { compileContainerLaunchPlan } from './container-launch-plan.js';
import type { ContainerConfig } from './container-config.js';
import type { EffectiveProviderConfig } from './providers/effective-provider.js';
import { resolveEffectiveRuntimeSelection } from './providers/effective-runtime.js';
import { requireRuntimeDescriptor } from './providers/runtime-descriptor-registry.js';
import './providers/runtime-descriptors/index.js';

const baseConfig: ContainerConfig = {
  mcpServers: {},
  packages: { apt: [], npm: [] },
  additionalMounts: [],
  skills: ['skill-removed-from-install'],
  sharedResources: [],
  cliScope: 'group',
};

describe.each([
  ['Claude', { provider: 'claude', runtimeStateKey: 'claude' }],
  ['Codex', { provider: 'codex', runtimeStateKey: 'codex' }],
] as const)('%s startup contract', (_name, effective) => {
  it('compiles stale persisted skills out and produces a runnable launch command', async () => {
    const effectiveProvider: EffectiveProviderConfig = { ...effective };
    const runtime = resolveEffectiveRuntimeSelection(effectiveProvider);
    const planned = compileEffectiveSessionPlan({
      config: structuredClone(baseConfig),
      effectiveProvider,
      runtime,
      runtimeDescriptor: requireRuntimeDescriptor(runtime.runtimeId),
    });

    expect(planned.skippedSkills).toEqual(['skill-removed-from-install']);
    expect(planned.gatedConfig.skills).toEqual([]);
    expect(planned.materializedPlan).toEqual(planned.compiledPlan);

    const launch = await compileContainerLaunchPlan({
      containerName: `test-${effective.provider}`,
      installLabel: 'nanoclaw-install=test',
      imageTag: 'nanoclaw-agent:test',
      timezone: 'UTC',
      networkArgs: [],
      mounts: [{ hostPath: '/session', containerPath: '/workspace', readonly: false }],
      agentName: 'Test Agent',
      agentIdentifier: `agent-${effective.provider}`,
      oauthCredentialsAvailable: false,
      ensureAgent: vi.fn(async () => undefined),
      applyGateway: vi.fn(async () => true),
    });

    expect(launch.args.slice(-3)).toEqual(['nanoclaw-agent:test', '-c', 'exec bun run /app/src/index.ts']);
  });
});
