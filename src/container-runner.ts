/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import { compileEffectiveSessionPlan } from './capabilities/compile-session-plan.js';
import {
  getRequiredCapabilitiesForSession,
  recordActiveAttemptRuntimeFacts,
  recordSessionCapabilityAuthorization,
} from './orchestration/run-store.js';
import { capabilityFingerprint, toolSchemaFingerprint } from './orchestration/invocation-fingerprint.js';
import type { SessionRuntimePlan } from './capabilities/session-runtime-plan.js';
import {
  CONTAINER_CPU_LIMIT,
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  CONTAINER_MEMORY_LIMIT,
  DATA_DIR,
  GROUPS_DIR,
  MAX_CONCURRENT_CONTAINERS,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { materializeContainerJson, materializeSessionRuntimeJson } from './container-config.js';
import {
  assertUniqueMountDestinations,
  compileContainerLaunchPlan,
  type ContainerLaunchPlan,
} from './container-launch-plan.js';
import { getContainerConfig } from './db/container-configs.js';
import { updateContainerConfigScalars } from './db/container-configs.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, stopContainer } from './container-runtime.js';
import { EGRESS_NETWORK, egressNetworkArgs, ensureEgressNetwork } from './egress-lockdown.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { isAgentGroupMemoryMaintenanceHeld } from './db/agent-group-memory-control.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { resolveAvailableSharedResources } from './shared-resources.js';
import { getSharedResourceControl } from './db/shared-resource-control.js';
import { discoverSkillCatalog, selectSkillCatalog } from './skills/catalog.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { readEnvFileByPrefix } from './env.js';
import { ensureRtkClaudeHook } from './rtk.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
import { validatePackageLists } from './package-names.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import { resolveEffectiveProviderConfig, type EffectiveProviderConfig } from './providers/effective-provider.js';
import { assertRuntimeSelectionParity, resolveEffectiveRuntimeSelection } from './providers/effective-runtime.js';
import type { EffectiveRuntimeSelection } from './providers/runtime-descriptor.js';
import { getRuntimeDescriptorByContainerFactory } from './providers/runtime-descriptor-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string; startedAtMs: number }>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
export type WakeContainerResult =
  | { status: 'already-running' | 'started' }
  | { status: 'capacity' }
  | { status: 'maintenance-held' }
  | { status: 'failed'; error: string };

const wakePromises = new Map<string, Promise<WakeContainerResult>>();
const wakeReservations = new Set<string>();

class MemoryMaintenanceHeldError extends Error {
  constructor() {
    super('Agent group memory maintenance fence is held');
    this.name = 'MemoryMaintenanceHeldError';
  }
}

export function tryReserveContainerSlot(
  sessionId: string,
  activeSessionIds: Iterable<string>,
  reservations: Set<string>,
  limit: number,
): boolean {
  if (reservations.has(sessionId)) return true;
  const admitted = new Set(activeSessionIds);
  for (const reserved of reservations) admitted.add(reserved);
  if (admitted.size >= limit) return false;
  reservations.add(sessionId);
  return true;
}

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

export function getContainerStartedAtMs(sessionId: string): number | undefined {
  return activeContainers.get(sessionId)?.startedAtMs;
}

export function isContainerWakeInFlight(sessionId: string): boolean {
  return wakePromises.has(sessionId) || wakeReservations.has(sessionId);
}

export async function drainContainerWakes(sessionIds: Iterable<string>): Promise<void> {
  const pending = [...sessionIds]
    .map((sessionId) => wakePromises.get(sessionId))
    .filter((promise): promise is Promise<WakeContainerResult> => promise !== undefined);
  await Promise.allSettled(pending);
}

interface RuntimeShadowLogger {
  debug: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
}

/**
 * Compute the additive runtime selection and verify it agrees with the
 * compatibility provider config. Shadow failures are non-fatal in Phase A.
 */
export function computeRuntimeShadow(
  effectiveProvider: EffectiveProviderConfig,
  logger: RuntimeShadowLogger = log,
): EffectiveRuntimeSelection | undefined {
  try {
    const selection = resolveEffectiveRuntimeSelection(effectiveProvider);
    assertRuntimeSelectionParity(effectiveProvider, selection);
    logger.debug('runtime shadow selection', { ...selection });
    return selection;
    // eslint-disable-next-line no-catch-all/no-catch-all -- Phase A shadow resolution must remain non-fatal for compatibility
  } catch (err) {
    logger.warn('runtime shadow resolution failed (non-fatal)', {
      provider: effectiveProvider.provider,
      err,
    });
    return undefined;
  }
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` when running/started, `false` on a
 * transient spawn failure or capacity deferral. Callers don't need to wrap —
 * the inbound row stays pending and host-sweep retries on its next tick.
 * Callers that care (e.g. the router's typing indicator) can branch on the
 * boolean.
 */
export async function wakeContainer(session: Session): Promise<boolean> {
  const result = await wakeContainerWithResult(session);
  return result.status === 'already-running' || result.status === 'started';
}

export function wakeContainerWithResult(session: Session): Promise<WakeContainerResult> {
  if (isAgentGroupMemoryMaintenanceHeld(session.agent_group_id)) {
    log.info('Container wake held for memory maintenance', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
    });
    return Promise.resolve({ status: 'maintenance-held' });
  }
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve({ status: 'already-running' });
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  if (!tryReserveContainerSlot(session.id, activeContainers.keys(), wakeReservations, MAX_CONCURRENT_CONTAINERS)) {
    log.info('Container wake deferred at concurrency limit', {
      sessionId: session.id,
      limit: MAX_CONCURRENT_CONTAINERS,
      active: activeContainers.size,
      reserved: wakeReservations.size,
    });
    return Promise.resolve({ status: 'capacity' });
  }
  const promise = spawnContainer(session)
    .then((): WakeContainerResult => ({ status: 'started' }))
    .catch((err): WakeContainerResult => {
      if (err instanceof MemoryMaintenanceHeldError) {
        log.info('Container spawn held for memory maintenance', {
          sessionId: session.id,
          agentGroupId: session.agent_group_id,
        });
        return { status: 'maintenance-held' };
      }
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    })
    .finally(() => {
      wakePromises.delete(session.id);
      wakeReservations.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    throw new Error(`Agent group not found: ${session.agent_group_id}`);
  }

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Materialize container.json from DB — writes fresh file and returns
  // the config object, threaded through provider resolution, buildMounts,
  // and buildContainerArgs so we don't re-read.
  const groupConfig = materializeContainerJson(agentGroup.id);
  const effectiveProvider = resolveEffectiveProviderConfig(session, groupConfig);
  const runtimeSelection = computeRuntimeShadow(effectiveProvider);
  const runtimeDescriptor = getRuntimeDescriptorByContainerFactory(effectiveProvider.provider);
  if (effectiveProvider.profile?.toolStrategy === 'native' && (!runtimeSelection || !runtimeDescriptor)) {
    throw new Error(`Verified tool profile could not resolve runtime: ${effectiveProvider.provider}`);
  }

  // Compile required capabilities before materializing or spawning. Runtimes
  // that cannot call tools receive no MCP server configuration.
  let planConfig = groupConfig;
  let sessionRuntimePlan: SessionRuntimePlan | undefined;
  if (runtimeSelection && runtimeDescriptor) {
    const planned = compileEffectiveSessionPlan({
      config: groupConfig,
      effectiveProvider,
      runtime: runtimeSelection,
      runtimeDescriptor,
      requiredCapabilities: getRequiredCapabilitiesForSession(session.id),
    });
    if (planned.skippedSkills.length > 0) {
      log.warn('Configured skills are not installed; continuing without them', {
        sessionId: session.id,
        skills: planned.skippedSkills,
      });
    }
    sessionRuntimePlan = planned.materializedPlan;
    planConfig = planned.gatedConfig;
    recordSessionCapabilityAuthorization(
      session.id,
      planned.compiledPlan.capabilities.map((capability) => capability.id),
    );
    recordActiveAttemptRuntimeFacts(session.id, {
      runtimeId: runtimeSelection.runtimeId,
      endpointProfileId: runtimeSelection.endpointProfileId,
      protocol: effectiveProvider.profile?.protocol ?? runtimeDescriptor.acceptedProtocols[0],
      continuationSemantics: runtimeDescriptor.stateSemantics.continuation,
      capabilityFingerprint: capabilityFingerprint(planned.compiledPlan),
      toolSchemaFingerprint: toolSchemaFingerprint(planned.compiledPlan),
      inputReconstructable:
        runtimeDescriptor.kind === 'protocol-loop' && runtimeDescriptor.stateSemantics.continuation === 'transcript',
    });
  } else {
    recordSessionCapabilityAuthorization(session.id, []);
  }
  const runtime = materializeSessionRuntimeJson(
    sessionDir(agentGroup.id, session.id),
    agentGroup,
    planConfig,
    effectiveProvider,
    sessionRuntimePlan,
    session.id,
  );
  const containerConfig = runtime.config;

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(
    session,
    agentGroup,
    containerConfig,
    effectiveProvider,
  );

  const mounts = buildMounts(agentGroup, session, containerConfig, contribution, runtime.path);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const launchPlan = await buildContainerLaunchPlan(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
  );

  // Recheck after asynchronous plan compilation and immediately before the
  // external spawn. A maintenance fence acquired while this wake was in
  // flight must prevent the container from crossing the process boundary.
  if (isAgentGroupMemoryMaintenanceHeld(agentGroup.id)) {
    throw new MemoryMaintenanceHeldError();
  }

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const container = spawn(launchPlan.executable, launchPlan.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    container.once('spawn', resolve);
    container.once('error', reject);
  });

  activeContainers.set(session.id, { process: container, containerName, startedAtMs: Date.now() });
  markContainerRunning(session.id);

  // Log stderr. Keep a small tail so boot failures are visible at the default
  // log level instead of only as debug lines.
  const stderrTail: string[] = [];
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (!line) continue;
      log.debug(line, { container: agentGroup.folder });
      stderrTail.push(line);
      if (stderrTail.length > 10) stderrTail.shift();
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    if (code !== 0 && code !== null && stderrTail.length > 0) {
      log.warn('Container exited non-zero', { sessionId: session.id, code, containerName, stderrTail });
    } else {
      log.info('Container exited', { sessionId: session.id, code, containerName });
    }
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  if (onExit) {
    entry.process.once('close', onExit);
  }

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Resolve the provider name for a session:
 *
 *   sessions.agent_provider
 *     → container_configs.provider
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  effectiveProvider: EffectiveProviderConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = effectiveProvider.provider;
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        groupDir: path.resolve(GROUPS_DIR, agentGroup.folder),
        selectedSkills: containerConfig.skills,
        containerConfig,
        hostEnv: process.env,
        effectiveProvider,
      })
    : {};
  return { provider, contribution };
}

export function buildGroupWorkspaceMounts(groupDir: string, includeManagedDocs = true): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const workspacePaths = ['/workspace/agent', '/workspace/group'];

  for (const containerPath of workspacePaths) {
    mounts.push({ hostPath: groupDir, containerPath, readonly: false });
  }

  // Nested read-only mounts must be applied on both aliases. Otherwise the
  // compatibility /workspace/group path would make managed files writable.
  // container.json is intentionally excluded: each session mounts its own
  // effective runtime config after provider resolution.
  const managedPaths = includeManagedDocs
    ? [
        { hostPath: path.join(groupDir, 'CLAUDE.md'), relativePath: 'CLAUDE.md' },
        { hostPath: path.join(groupDir, '.claude-fragments'), relativePath: '.claude-fragments' },
      ]
    : [];
  for (const managedPath of managedPaths) {
    if (!fs.existsSync(managedPath.hostPath)) continue;
    for (const containerPath of workspacePaths) {
      mounts.push({
        hostPath: managedPath.hostPath,
        containerPath: path.posix.join(containerPath, managedPath.relativePath),
        readonly: true,
      });
    }
  }

  return mounts;
}

export function buildSessionRuntimeConfigMounts(runtimeConfigPath: string): VolumeMount[] {
  return [
    { hostPath: runtimeConfigPath, containerPath: '/workspace/agent/container.json', readonly: true },
    { hostPath: runtimeConfigPath, containerPath: '/workspace/group/container.json', readonly: true },
  ];
}

export function buildSessionClaudeDocMounts(providerDocsDir: string): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const docPath = path.join(providerDocsDir, 'CLAUDE.md');
  const fragmentsPath = path.join(providerDocsDir, '.claude-fragments');
  for (const workspace of ['/workspace/agent', '/workspace/group']) {
    if (fs.existsSync(docPath)) {
      mounts.push({ hostPath: docPath, containerPath: `${workspace}/CLAUDE.md`, readonly: true });
    }
    if (fs.existsSync(fragmentsPath)) {
      mounts.push({
        hostPath: fragmentsPath,
        containerPath: `${workspace}/.claude-fragments`,
        readonly: true,
      });
    }
  }
  return mounts;
}

export function buildSessionWorkspaceMounts(sessDir: string): VolumeMount[] {
  return [
    { hostPath: sessDir, containerPath: '/workspace', readonly: false },
    {
      hostPath: path.join(sessDir, 'inbound.db'),
      containerPath: '/workspace/inbound.db',
      readonly: true,
    },
  ];
}

export function buildRtkStateMount(agentGroupId: string): VolumeMount {
  return {
    hostPath: path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.rtk'),
    containerPath: '/home/node/.local/share/rtk',
    readonly: false,
  };
}

const MEMORY_MOUNT_DESTINATIONS = ['/workspace/agent/memory', '/workspace/group/memory'] as const;

function normalizedContainerPath(value: string): string {
  return value.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

export function buildMemoryAccessMounts(
  groupDir: string,
  memory: import('./agent-profile.js').AgentMemoryProfile | undefined,
  existingMounts: VolumeMount[] = [],
): VolumeMount[] {
  if (!memory || memory.mode === 'disabled') return [];
  if (memory.access === 'read-write') return [];
  if (memory.access !== 'read-only') {
    throw new Error(`Enabled neutral memory has invalid access: ${memory.access}`);
  }
  if (memory.neutralMemoryRoot !== '/workspace/agent/memory') {
    throw new Error(`Enabled neutral memory has invalid canonical root: ${memory.neutralMemoryRoot}`);
  }

  const memoryRoot = path.join(groupDir, 'memory');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(memoryRoot);
  } catch (err) {
    throw new Error(`Read-only memory root is unavailable: ${memoryRoot}`, { cause: err });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Read-only memory root is unsafe: ${memoryRoot}`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== 0 && stat.uid !== currentUid) {
    throw new Error(`Read-only memory root has unsafe ownership: ${memoryRoot}`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`Read-only memory root has unsafe mode: ${memoryRoot}`);
  }
  if (fs.realpathSync(memoryRoot) !== path.resolve(memoryRoot)) {
    throw new Error(`Read-only memory root resolves outside its canonical path: ${memoryRoot}`);
  }

  for (const mount of existingMounts) {
    const destination = normalizedContainerPath(mount.containerPath);
    for (const protectedRoot of MEMORY_MOUNT_DESTINATIONS) {
      if (destination === protectedRoot || destination.startsWith(`${protectedRoot}/`)) {
        throw new Error(`Mount conflicts with protected memory subtree: ${destination}`);
      }
    }
  }

  return MEMORY_MOUNT_DESTINATIONS.map((containerPath) => ({
    hostPath: memoryRoot,
    containerPath,
    readonly: true,
  }));
}

export { assertUniqueMountDestinations };

function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  providerContribution: ProviderContainerContribution,
  runtimeConfigPath: string,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before.
  initGroupFilesystem(agentGroup);

  // Sync skill symlinks based on container.json selection before mounting.
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  syncSkillSymlinks(claudeDir, containerConfig);

  // Idempotently inject RTK PreToolUse hook into settings.json so all container
  // Bash calls are compressed before reaching the LLM context window.
  ensureRtkClaudeHook(path.join(claudeDir, 'settings.json'));

  // Compose the effective Claude project doc below the private session
  // directory. Group workspaces can host concurrent sessions with different
  // capability plans, so generated provider docs must never be shared.
  const providerDocsDir = path.join(sessionDir(agentGroup.id, session.id), 'provider-docs');
  composeGroupClaudeMd(agentGroup, { outputDir: providerDocsDir, containerConfig });

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // The session folder must remain writable for outbound.db, outbox/, and
  // provider state. Overlay the host-owned inbound DB read-only so the
  // container can consume messages without mutating host-owned state.
  mounts.push(...buildSessionWorkspaceMounts(sessDir));

  mounts.push(...buildGroupWorkspaceMounts(groupDir, false));
  mounts.push(...buildSessionClaudeDocMounts(providerDocsDir));

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Shared resources are opt-in per group. Symlinks land in the group workspace
  // so both /workspace/agent/shared and /workspace/group/shared work.
  syncSharedResourceSymlinks(groupDir, containerConfig);
  mounts.push(...buildSharedResourceMounts(agentGroup.id, containerConfig, projectRoot));
  const docsDir = path.join(projectRoot, 'docs');
  if (fs.existsSync(docsDir)) {
    mounts.push({ hostPath: docsDir, containerPath: '/app/docs', readonly: true });
  }

  // Compatibility Claude entry point and its provider-aware runtime sources.
  // Session-specific provider docs inline these sources, but keeping the
  // legacy /app/CLAUDE.md import graph valid avoids breaking direct consumers.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }
  const sharedRuntimeDir = path.join(process.cwd(), 'container', 'runtime');
  if (fs.existsSync(sharedRuntimeDir)) {
    mounts.push({ hostPath: sharedRuntimeDir, containerPath: '/app/runtime', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // RTK analytics and failure-recovery output must survive container
  // replacement and remain shared when an agent group switches providers.
  const rtkStateMount = buildRtkStateMount(agentGroup.id);
  fs.mkdirSync(rtkStateMount.hostPath, { recursive: true });
  mounts.push(rtkStateMount);

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  // Enabled non-writer sessions receive a nested read-only overlay on both
  // workspace aliases. Reject child mounts before adding the overlay so a
  // later bind cannot punch a writable hole through the protected subtree.
  mounts.push(...buildMemoryAccessMounts(groupDir, containerConfig.agentProfile?.memory, mounts));

  // Final nested overlays: each session must see its own effective provider
  // selection even though the group workspace (and its operator snapshot
  // container.json) is shared by every session.
  mounts.push(...buildSessionRuntimeConfigMounts(runtimeConfigPath));

  // Docker rejects duplicate bind destinations with exit code 125. Catch
  // collisions here so provider or additional mounts cannot silently recreate
  // this outage class.
  assertUniqueMountDestinations(mounts);

  return mounts;
}

/**
 * Compile one mount per explicit grant. Pilot/uncontrolled resources are
 * read-only; only the approved owner of a reconciled resource receives write
 * access. Mounting the shared root is forbidden because it bypasses grants.
 */
export function buildSharedResourceMounts(
  agentGroupId: string,
  containerConfig: import('./container-config.js').ContainerConfig,
  projectRoot = process.cwd(),
): VolumeMount[] {
  const available = resolveAvailableSharedResources(projectRoot);
  const mounts: VolumeMount[] = [];
  const seen = new Set<string>();
  for (const name of containerConfig.sharedResources ?? []) {
    if (name === 'docs' || seen.has(name)) continue;
    seen.add(name);
    const containerPath = available.get(name);
    if (!containerPath || !containerPath.startsWith('/app/shared/')) continue;
    const control = getSharedResourceControl(name);
    const writable = control?.reconciliation_state === 'reconciled' && control.owner_agent_group_id === agentGroupId;
    mounts.push({
      hostPath: path.join(projectRoot, 'groups', 'shared', name),
      containerPath,
      readonly: !writable,
    });
  }
  return mounts;
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
export function syncSkillSymlinks(
  claudeDir: string,
  containerConfig: import('./container-config.js').ContainerConfig,
): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  const projectRoot = process.cwd();
  const selected = selectSkillCatalog(discoverSkillCatalog(projectRoot), containerConfig.skills);
  const desired = new Map(
    selected.entries.filter((entry) => !entry.error).map((entry) => [entry.name, entry.containerPath]),
  );

  // Remove symlinks that are no longer in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    try {
      if (fs.lstatSync(entryPath).isSymbolicLink() && !desired.has(entry)) {
        fs.unlinkSync(entryPath);
      }
    } catch {
      /* skip */
    }
  }

  // Create or update symlinks for the desired set. Older installs may
  // have copied skill directories here; selected skills must be replaced so
  // runtime uses the current /app/skills mount instead of stale files.
  for (const [skill, containerTarget] of desired) {
    const linkPath = path.join(skillsDir, skill);
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        if (fs.readlinkSync(linkPath) === containerTarget) continue;
        fs.unlinkSync(linkPath); // stale target — recreate below
      } else {
        fs.rmSync(linkPath, { recursive: true, force: true });
      }
    } catch {
      /* missing — fall through to create */
    }
    fs.symlinkSync(containerTarget, linkPath);
  }
}

/**
 * Sync shared-resource symlinks in <groupDir>/shared/ to match the
 * container.json `sharedResources` selection. Symlink targets are container
 * paths, dangling on the host but valid once /app/shared and /app/docs mount.
 */
export function syncSharedResourceSymlinks(
  groupDir: string,
  containerConfig: import('./container-config.js').ContainerConfig,
): void {
  const linksDir = path.join(groupDir, 'shared');
  if (!fs.existsSync(linksDir)) fs.mkdirSync(linksDir, { recursive: true });

  const available = resolveAvailableSharedResources(process.cwd());

  const desired = new Map<string, string>();
  for (const resource of containerConfig.sharedResources ?? []) {
    const target = available.get(resource);
    if (!target || desired.has(resource)) continue;
    desired.set(resource, target);
  }

  for (const entry of fs.readdirSync(linksDir)) {
    const entryPath = path.join(linksDir, entry);
    try {
      if (fs.lstatSync(entryPath).isSymbolicLink() && !desired.has(entry)) {
        fs.unlinkSync(entryPath);
      }
    } catch {
      /* skip */
    }
  }

  for (const [resource, containerTarget] of desired) {
    const linkPath = path.join(linksDir, resource);
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        if (fs.readlinkSync(linkPath) === containerTarget) continue;
        fs.unlinkSync(linkPath);
      } else {
        fs.rmSync(linkPath, { recursive: true, force: true });
      }
    } catch {
      /* missing */
    }
    fs.symlinkSync(containerTarget, linkPath);
  }
}

async function buildContainerLaunchPlan(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  _provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
): Promise<ContainerLaunchPlan> {
  const lockdown = ensureEgressNetwork();
  if (lockdown) {
    log.info('Egress lockdown active', { containerName, network: EGRESS_NETWORK });
  }
  const credsPath = path.join(process.env.HOME ?? '', '.claude', '.credentials.json');
  let oauthCredentialsAvailable = false;
  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8')) as Record<string, unknown>;
    oauthCredentialsAvailable = Boolean((creds?.claudeAiOauth as Record<string, unknown> | undefined)?.accessToken);
  } catch {
    // API key mode via OneCLI is correct.
  }
  const plan = await compileContainerLaunchPlan({
    containerName,
    installLabel: CONTAINER_INSTALL_LABEL,
    imageTag: containerConfig.imageTag || CONTAINER_IMAGE,
    timezone: TIMEZONE,
    cpuLimit: CONTAINER_CPU_LIMIT,
    memoryLimit: CONTAINER_MEMORY_LIMIT,
    environment: providerContribution.env,
    secrets: readEnvFileByPrefix('CONTAINER_SECRET_'),
    networkArgs: lockdown ? egressNetworkArgs() : hostGatewayArgs(),
    mounts,
    hostUid: process.getuid?.(),
    hostGid: process.getgid?.(),
    agentIdentifier,
    agentName: agentGroup.name,
    oauthCredentialsAvailable,
    ensureAgent: (input) => onecli.ensureAgent(input),
    applyGateway: (args, agent) => onecli.applyContainerConfig(args, { addHostMapping: false, agent }),
  });
  log.info('OneCLI gateway applied', { containerName });
  return { ...plan, executable: CONTAINER_RUNTIME_BIN };
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const { apt: aptPackages, npm: npmPackages } = validatePackageLists(
    JSON.parse(configRow.packages_apt),
    JSON.parse(configRow.packages_npm),
  );
  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, ['build', '-t', imageTag, '-f', tmpDockerfile, '.'], {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
