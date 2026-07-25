import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { CONTAINER_IMAGE, GROUPS_DIR } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';

const execFileAsync = promisify(execFile);
const VALIDATOR_OUTPUT_MAX_BYTES = 256 * 1024;

export interface MemoryValidatorContainerDeps {
  execute?: (
    executable: string,
    args: string[],
    options: { encoding: 'utf8'; maxBuffer: number; timeout: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  projectRoot?: string;
}

export function buildMemoryValidatorContainerArgs(
  groupDir: string,
  runnerSource: string,
  image: string,
  hostUid = process.getuid?.() ?? 1000,
  hostGid = process.getgid?.() ?? 1000,
): string[] {
  return [
    'run',
    '--rm',
    '--user',
    `${hostUid}:${hostGid}`,
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=16m',
    '--mount',
    `type=bind,src=${groupDir},dst=/workspace/agent,readonly`,
    '--mount',
    `type=bind,src=${runnerSource},dst=/app/src,readonly`,
    '--entrypoint',
    'bun',
    image,
    '/app/src/memory/validator-cli.ts',
    '/workspace/agent/memory',
  ];
}

function resolveGroupWorkspace(folder: string): string {
  const groupsRoot = fs.realpathSync(GROUPS_DIR);
  const candidate = fs.realpathSync(path.join(groupsRoot, folder));
  if (candidate !== groupsRoot && !candidate.startsWith(`${groupsRoot}${path.sep}`)) {
    throw new Error('Agent group workspace escapes the configured groups directory');
  }
  return candidate;
}

function safeResourceName(resourceName: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(resourceName) || resourceName === 'docs') {
    throw new Error(`Invalid shared resource name: ${resourceName}`);
  }
  return resourceName;
}

export function selectSharedMemoryRoot(resourceDir: string): '' | 'knowledge' {
  const rootIndex = path.join(resourceDir, 'index.md');
  try {
    const stat = fs.lstatSync(rootIndex);
    if (stat.isFile() && !stat.isSymbolicLink()) return '';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const nestedRoot = path.join(resourceDir, 'knowledge');
  const nestedIndex = path.join(nestedRoot, 'index.md');
  const rootStat = fs.lstatSync(nestedRoot);
  if (
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    fs.realpathSync(nestedRoot) !== path.resolve(nestedRoot)
  ) {
    throw new Error('Shared OKF root must be a real directory with a regular index');
  }
  const indexStat = fs.lstatSync(nestedIndex);
  if (indexStat.isSymbolicLink() || !indexStat.isFile()) {
    throw new Error('Shared OKF root must be a real directory with a regular index');
  }
  return 'knowledge';
}

export async function runMemoryValidatorContainer(
  agentGroupId: string,
  deps: MemoryValidatorContainerDeps = {},
): Promise<unknown> {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);
  const groupDir = resolveGroupWorkspace(group.folder);
  const projectRoot = deps.projectRoot ?? process.cwd();
  const runnerSource = path.join(projectRoot, 'container', 'agent-runner', 'src');
  const args = buildMemoryValidatorContainerArgs(groupDir, runnerSource, CONTAINER_IMAGE);
  const execute = deps.execute ?? ((executable, argv, options) => execFileAsync(executable, argv, options));
  const { stdout } = await execute('docker', args, {
    encoding: 'utf8',
    maxBuffer: VALIDATOR_OUTPUT_MAX_BYTES,
    timeout: 60_000,
  });
  if (Buffer.byteLength(stdout, 'utf8') > VALIDATOR_OUTPUT_MAX_BYTES) {
    throw new Error('Memory validator output exceeded its host-side bound');
  }
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray(parsed.findings) ||
    parsed.findings.length > 256
  ) {
    throw new Error('Memory validator returned an invalid report');
  }
  return parsed;
}

export async function runSharedMemoryValidatorContainer(
  resourceName: string,
  image = CONTAINER_IMAGE,
  deps: MemoryValidatorContainerDeps = {},
): Promise<unknown> {
  const name = safeResourceName(resourceName);
  const groupsRoot = fs.realpathSync(GROUPS_DIR);
  const resourceDir = fs.realpathSync(path.join(groupsRoot, 'shared', name));
  const sharedRoot = path.join(groupsRoot, 'shared');
  if (!resourceDir.startsWith(`${sharedRoot}${path.sep}`)) {
    throw new Error('Shared resource escapes the configured shared root');
  }
  const projectRoot = deps.projectRoot ?? process.cwd();
  const runnerSource = path.join(projectRoot, 'container', 'agent-runner', 'src');
  const args = buildMemoryValidatorContainerArgs(resourceDir, runnerSource, image);
  const rootIndex = args.lastIndexOf('/workspace/agent/memory');
  const relativeRoot = selectSharedMemoryRoot(resourceDir);
  args[rootIndex] = relativeRoot ? `/workspace/agent/${relativeRoot}` : '/workspace/agent';
  const execute = deps.execute ?? ((executable, argv, options) => execFileAsync(executable, argv, options));
  const { stdout } = await execute('docker', args, {
    encoding: 'utf8',
    maxBuffer: VALIDATOR_OUTPUT_MAX_BYTES,
    timeout: 60_000,
  });
  if (Buffer.byteLength(stdout, 'utf8') > VALIDATOR_OUTPUT_MAX_BYTES) {
    throw new Error('Shared memory validator output exceeded its host-side bound');
  }
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray(parsed.findings) ||
    parsed.findings.length > 256
  ) {
    throw new Error('Shared memory validator returned an invalid report');
  }
  return parsed;
}
