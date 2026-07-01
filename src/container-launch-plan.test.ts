import { describe, expect, it, vi } from 'vitest';

import { compileContainerLaunchPlan, type ContainerLaunchPlanInput } from './container-launch-plan.js';

function input(overrides: Partial<ContainerLaunchPlanInput> = {}): ContainerLaunchPlanInput {
  return {
    containerName: 'nanoclaw-test',
    installLabel: 'nanoclaw-install=test',
    imageTag: 'nanoclaw-agent:test',
    timezone: 'UTC',
    environment: { PROVIDER_MODE: 'test' },
    secrets: { CONTAINER_SECRET_TOKEN: 'secret' },
    networkArgs: ['--add-host=host.docker.internal:host-gateway'],
    mounts: [
      { hostPath: '/host/workspace', containerPath: '/workspace', readonly: false },
      { hostPath: '/host/config', containerPath: '/workspace/agent/container.json', readonly: true },
    ],
    hostUid: 1001,
    hostGid: 1001,
    agentIdentifier: 'agent-id',
    agentName: 'Agent',
    oauthCredentialsAvailable: false,
    ensureAgent: vi.fn(async () => undefined),
    applyGateway: vi.fn(async (args) => {
      args.push('-e', 'HTTPS_PROXY=http://gateway');
      args.push('-v', '/gateway/auth.json:/home/node/.codex/auth.json:ro');
      return true;
    }),
    ...overrides,
  };
}

describe('compileContainerLaunchPlan', () => {
  it('builds an executable launch plan and applies nested gateway mounts after parent mounts', async () => {
    const plan = await compileContainerLaunchPlan(input({ cpuLimit: '2', memoryLimit: '1g' }));
    expect(plan.executable).toBe('docker');
    expect(plan.args).toEqual(
      expect.arrayContaining([
        '--cpus',
        '2',
        '--memory',
        '1g',
        '--user',
        '1001:1001',
        '-e',
        'HOME=/home/node',
        '-e',
        'PROVIDER_MODE=test',
        '-e',
        'CONTAINER_SECRET_TOKEN=secret',
      ]),
    );
    const parentMount = plan.args.indexOf('/host/workspace:/workspace');
    const nestedGatewayMount = plan.args.indexOf('/gateway/auth.json:/home/node/.codex/auth.json:ro');
    expect(parentMount).toBeGreaterThan(-1);
    expect(nestedGatewayMount).toBeGreaterThan(parentMount);
    expect(plan.args.slice(-5)).toEqual([
      '--entrypoint',
      'bash',
      'nanoclaw-agent:test',
      '-c',
      'exec bun run /app/src/index.ts',
    ]);
  });

  it('fails closed when credential gateway application fails', async () => {
    await expect(compileContainerLaunchPlan(input({ applyGateway: async () => false }))).rejects.toThrow(
      'refusing to spawn container without credentials',
    );
  });

  it('rejects duplicate normalized mount destinations before gateway effects', async () => {
    const ensureAgent = vi.fn(async () => undefined);
    await expect(
      compileContainerLaunchPlan(
        input({
          ensureAgent,
          mounts: [
            { hostPath: '/one', containerPath: '/workspace/config', readonly: true },
            { hostPath: '/two', containerPath: '/workspace//config/', readonly: true },
          ],
        }),
      ),
    ).rejects.toThrow('Duplicate container mount destination');
    expect(ensureAgent).not.toHaveBeenCalled();
  });

  it('adds OAuth placeholders only when host OAuth credentials exist', async () => {
    const oauth = await compileContainerLaunchPlan(input({ oauthCredentialsAvailable: true }));
    expect(oauth.args).toEqual(
      expect.arrayContaining([
        'CLAUDE_CODE_OAUTH_TOKEN=placeholder',
        'ANTHROPIC_AUTH_TOKEN=placeholder',
        'ANTHROPIC_API_KEY=',
      ]),
    );
    const apiKey = await compileContainerLaunchPlan(input({ oauthCredentialsAvailable: false }));
    expect(apiKey.args).not.toContain('CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  });
});
