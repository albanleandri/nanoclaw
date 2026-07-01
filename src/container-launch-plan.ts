import type { VolumeMount } from './providers/provider-container-registry.js';

export interface ContainerLaunchPlanInput {
  containerName: string;
  installLabel: string;
  imageTag: string;
  timezone: string;
  cpuLimit?: string;
  memoryLimit?: string;
  environment?: Record<string, string>;
  secrets?: Record<string, string>;
  networkArgs: string[];
  mounts: VolumeMount[];
  hostUid?: number;
  hostGid?: number;
  agentIdentifier?: string;
  agentName: string;
  oauthCredentialsAvailable: boolean;
  ensureAgent(input: { name: string; identifier: string }): Promise<unknown>;
  applyGateway(args: string[], agentIdentifier?: string): Promise<boolean>;
}

export interface ContainerLaunchPlan {
  executable: string;
  args: string[];
  containerName: string;
}

/**
 * Deterministically assemble and validate the complete container command.
 *
 * External gateway operations are injected so ordering and failure behavior
 * can be tested without Docker or OneCLI.
 */
export async function compileContainerLaunchPlan(input: ContainerLaunchPlanInput): Promise<ContainerLaunchPlan> {
  assertUniqueMountDestinations(input.mounts);
  const args = ['run', '--rm', '--name', input.containerName, '--label', input.installLabel];

  if (input.cpuLimit) args.push('--cpus', input.cpuLimit);
  if (input.memoryLimit) args.push('--memory', input.memoryLimit);
  args.push('-e', `TZ=${input.timezone}`);

  for (const [key, value] of Object.entries(input.environment ?? {})) args.push('-e', `${key}=${value}`);
  for (const [key, value] of Object.entries(input.secrets ?? {})) args.push('-e', `${key}=${value}`);
  args.push(...input.networkArgs);

  if (input.hostUid != null && input.hostUid !== 0 && input.hostUid !== 1000) {
    args.push('--user', `${input.hostUid}:${input.hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of input.mounts) {
    args.push('-v', `${mount.hostPath}:${mount.containerPath}${mount.readonly ? ':ro' : ''}`);
  }

  if (input.agentIdentifier) {
    await input.ensureAgent({ name: input.agentName, identifier: input.agentIdentifier });
  }
  if (!(await input.applyGateway(args, input.agentIdentifier))) {
    throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
  }

  if (input.oauthCredentialsAvailable) {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
    args.push('-e', 'ANTHROPIC_AUTH_TOKEN=placeholder');
    args.push('-e', 'ANTHROPIC_API_KEY=');
  }

  args.push('--entrypoint', 'bash', input.imageTag, '-c', 'exec bun run /app/src/index.ts');
  return { executable: 'docker', args, containerName: input.containerName };
}

export function assertUniqueMountDestinations(mounts: VolumeMount[]): void {
  const seen = new Set<string>();
  for (const mount of mounts) {
    const normalized = mount.containerPath.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    if (seen.has(normalized)) throw new Error(`Duplicate container mount destination: ${normalized}`);
    seen.add(normalized);
  }
}
