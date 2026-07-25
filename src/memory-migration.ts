import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { drainContainerWakes, isContainerRunning, killContainer } from './container-runner.js';
import {
  acquireAgentGroupMemoryFence,
  getAgentGroupMemoryControl,
  releaseAgentGroupMemoryFence,
  restoreAgentGroupMemoryControl,
  transitionAgentGroupMemoryControl,
  type AgentGroupMemoryControl,
} from './db/agent-group-memory-control.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getMessagingGroupsByAgentGroup } from './db/messaging-groups.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { listLiveTasks, pauseTask, resumeTask } from './modules/scheduling/db.js';
import { runMemoryValidatorContainer } from './memory-operator.js';
import { openInboundDb } from './session-manager.js';

export type MigrationStage =
  | 'created'
  | 'fenced'
  | 'inventoried'
  | 'paused'
  | 'stopped'
  | 'backed-up'
  | 'staging'
  | 'files-staged'
  | 'classified'
  | 'validated'
  | 'approved'
  | 'awaiting-smoke'
  | 'rolling-back-pre'
  | 'rolling-back-post'
  | 'completed'
  | 'rolled-back';

interface StagedPath {
  source: string;
  staged: string;
  kind: 'regular' | 'symlink';
}

interface ScheduledSeries {
  session_id: string;
  series_id: string;
  status: string;
  recurrence: string | null;
  process_after: string | null;
}

export interface MemoryMigrationLedger {
  schema_version: 1;
  workflow_id: string;
  agent_group_id: string;
  group_folder: string;
  stage: MigrationStage;
  created_at: string;
  updated_at: string;
  fence_owner: string;
  fence_token: string;
  prior_control: Pick<AgentGroupMemoryControl, 'mode' | 'migration_state' | 'writer_session_id'>;
  sessions: Array<{ id: string; status: string; container_status: string }>;
  active_containers: string[];
  messaging_routes: Array<{ id: string; channel_type: string; platform_id: string }>;
  scheduled_series: ScheduledSeries[];
  paused_series: Array<{ session_id: string; series_id: string }>;
  backup?: { path: string; sha256: string; bytes: number };
  requested_legacy_paths: string[];
  staged_paths: StagedPath[];
  classification_report?: { path: string; sha256: string; entries: number };
  validation?: { ok: boolean; checked_at: string };
  smoke_report?: { path: string; sha256: string; checks: string[] };
  writer_session_id?: string;
  approved_at?: string;
  completed_at?: string;
  rollback?: { kind: 'pre-approval' | 'post-approval'; displaced_workspace?: string; at: string };
}

interface MemoryClassificationEntry {
  source: string;
  classification: 'standing-instruction' | 'private-memory' | 'omit';
  destination?: string;
  destination_sha256?: string;
  reason?: string;
}

interface MemoryClassificationReport {
  workflow_id: string;
  entries: MemoryClassificationEntry[];
}

const MIGRATIONS_DIR = path.join(DATA_DIR, 'memory-migrations');
const WORK_DIR = '.nanoclaw-memory-migration';

function ledgerPath(agentGroupId: string): string {
  return path.join(MIGRATIONS_DIR, agentGroupId, 'ledger.json');
}

function safeRelative(input: string): string {
  if (!input || path.isAbsolute(input) || input.includes('\0')) throw new Error(`Unsafe legacy path: ${input}`);
  const normalized = path.posix.normalize(input.replaceAll('\\', '/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Unsafe legacy path: ${input}`);
  }
  if (
    normalized === 'memory' ||
    normalized.startsWith('memory/') ||
    normalized === WORK_DIR ||
    normalized.startsWith(`${WORK_DIR}/`)
  ) {
    throw new Error(`Legacy staging path is reserved: ${input}`);
  }
  return normalized;
}

function safeDestinationRelative(input: string): string {
  const normalized = path.posix.normalize(input.replaceAll('\\', '/'));
  if (!input || path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Unsafe classification destination: ${input}`);
  }
  return normalized;
}

function atomicWriteLedger(ledger: MemoryMigrationLedger): void {
  const target = ledgerPath(ledger.agent_group_id);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  ledger.updated_at = new Date().toISOString();
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function readMemoryMigrationLedger(agentGroupId: string): MemoryMigrationLedger | undefined {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(agentGroupId), 'utf8')) as MemoryMigrationLedger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function requireLedger(agentGroupId: string): MemoryMigrationLedger {
  const ledger = readMemoryMigrationLedger(agentGroupId);
  if (!ledger) throw new Error(`No memory migration workflow exists for group: ${agentGroupId}`);
  return ledger;
}

function resolveWorkspace(ledger: MemoryMigrationLedger): string {
  const workspace = path.join(GROUPS_DIR, ledger.group_folder);
  if (path.dirname(workspace) !== GROUPS_DIR) throw new Error('Resolved group workspace escapes groups directory');
  return workspace;
}

function sha256(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function nodeExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function inventory(ledger: MemoryMigrationLedger): void {
  const sessions = getSessionsByAgentGroup(ledger.agent_group_id);
  ledger.sessions = sessions.map((session) => ({
    id: session.id,
    status: session.status,
    container_status: session.container_status,
  }));
  ledger.active_containers = sessions.filter((session) => isContainerRunning(session.id)).map((session) => session.id);
  ledger.messaging_routes = getMessagingGroupsByAgentGroup(ledger.agent_group_id).map((route) => ({
    id: route.id,
    channel_type: route.channel_type,
    platform_id: route.platform_id,
  }));
  ledger.scheduled_series = [];
  for (const session of sessions) {
    const db = openInboundDb(ledger.agent_group_id, session.id);
    try {
      for (const task of listLiveTasks(db)) {
        ledger.scheduled_series.push({
          session_id: session.id,
          series_id: task.id,
          status: task.status,
          recurrence: task.recurrence,
          process_after: task.process_after,
        });
      }
    } finally {
      db.close();
    }
  }
}

function pauseScheduledSeries(ledger: MemoryMigrationLedger): void {
  for (const task of ledger.scheduled_series.filter((item) => item.status === 'pending')) {
    if (ledger.paused_series.some((item) => item.session_id === task.session_id && item.series_id === task.series_id)) {
      continue;
    }
    const db = openInboundDb(ledger.agent_group_id, task.session_id);
    try {
      pauseTask(db, task.series_id);
    } finally {
      db.close();
    }
    ledger.paused_series.push({ session_id: task.session_id, series_id: task.series_id });
    atomicWriteLedger(ledger);
  }
}

async function stopContainers(ledger: MemoryMigrationLedger): Promise<void> {
  const ids = ledger.sessions.map((session) => session.id);
  await drainContainerWakes(ids);
  await Promise.all(
    ids.map(
      (id) =>
        new Promise<void>((resolve) => {
          if (!isContainerRunning(id)) return resolve();
          killContainer(id, `memory migration ${ledger.workflow_id}`, resolve);
        }),
    ),
  );
  await drainContainerWakes(ids);
  const remaining = ids.filter((id) => isContainerRunning(id));
  if (remaining.length) throw new Error(`Containers remained active after stop: ${remaining.join(', ')}`);
}

function createBackup(ledger: MemoryMigrationLedger): void {
  const workspace = resolveWorkspace(ledger);
  const backup = path.join(path.dirname(ledgerPath(ledger.agent_group_id)), `${ledger.workflow_id}.tar`);
  if (!fs.existsSync(backup)) {
    execFileSync('tar', ['--create', '--file', backup, '--directory', GROUPS_DIR, '--', ledger.group_folder], {
      stdio: 'pipe',
    });
    fs.chmodSync(backup, 0o600);
  }
  execFileSync('tar', ['--list', '--file', backup], { stdio: 'pipe' });
  const stat = fs.statSync(backup);
  if (!stat.isFile() || stat.size === 0 || !fs.existsSync(workspace))
    throw new Error('Workspace backup verification failed');
  ledger.backup = { path: backup, sha256: sha256(backup), bytes: stat.size };
}

function stageLegacyPaths(ledger: MemoryMigrationLedger): void {
  const workspace = resolveWorkspace(ledger);
  const workRoot = path.join(workspace, WORK_DIR, ledger.workflow_id);
  for (const relative of ledger.requested_legacy_paths) {
    if (ledger.staged_paths.some((entry) => entry.source === relative)) continue;
    const source = path.join(workspace, relative);
    const stagedCandidate = path.join(workRoot, 'staged', relative);
    const quarantineCandidate = path.join(workRoot, 'quarantine', relative);
    const recovered = [
      { target: stagedCandidate, kind: 'regular' as const },
      { target: quarantineCandidate, kind: 'symlink' as const },
    ].filter((candidate) => nodeExists(candidate.target));
    if (recovered.length > 1) throw new Error(`Ambiguous interrupted staging state: ${relative}`);
    if (recovered.length === 1 && !nodeExists(source)) {
      ledger.staged_paths.push({
        source: relative,
        staged: path.relative(workspace, recovered[0].target),
        kind: recovered[0].kind,
      });
      atomicWriteLedger(ledger);
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const kind = stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'regular' : undefined;
    if (!kind) throw new Error(`Refusing special or directory legacy node: ${relative}`);
    const bucket = kind === 'symlink' ? 'quarantine' : 'staged';
    const destination = path.join(workRoot, bucket, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (nodeExists(destination)) throw new Error(`Staging collision: ${path.relative(workspace, destination)}`);
    fs.renameSync(source, destination);
    ledger.staged_paths.push({ source: relative, staged: path.relative(workspace, destination), kind });
    atomicWriteLedger(ledger);
  }
}

function transition(
  ledger: MemoryMigrationLedger,
  mode: 'shadow' | 'active',
  migrationState: 'staging' | 'validated' | 'migrated',
  writerSessionId: string | null,
): void {
  const control = getAgentGroupMemoryControl(ledger.agent_group_id);
  if (!control) throw new Error('Memory control row disappeared');
  if (
    control.mode === mode &&
    control.migration_state === migrationState &&
    control.writer_session_id === writerSessionId
  ) {
    return;
  }
  transitionAgentGroupMemoryControl(ledger.agent_group_id, control.version, {
    mode,
    migrationState,
    writerSessionId,
  });
}

export async function prepareMemoryMigration(
  agentGroupId: string,
  requestedLegacyPaths: string[] = ['CLAUDE.local.md'],
): Promise<MemoryMigrationLedger> {
  let ledger = readMemoryMigrationLedger(agentGroupId);
  if (ledger && !['completed', 'rolled-back'].includes(ledger.stage)) {
    if (JSON.stringify(ledger.requested_legacy_paths) !== JSON.stringify(requestedLegacyPaths.map(safeRelative))) {
      throw new Error('An active workflow already exists with a different legacy path manifest');
    }
  } else {
    const group = getAgentGroup(agentGroupId);
    const control = getAgentGroupMemoryControl(agentGroupId);
    if (!group || !control) throw new Error(`Agent group not found or lacks memory control: ${agentGroupId}`);
    const now = new Date().toISOString();
    ledger = {
      schema_version: 1,
      workflow_id: randomUUID(),
      agent_group_id: agentGroupId,
      group_folder: group.folder,
      stage: 'created',
      created_at: now,
      updated_at: now,
      fence_owner: `memory-migration:${agentGroupId}`,
      fence_token: randomUUID(),
      prior_control: {
        mode: control.mode,
        migration_state: control.migration_state,
        writer_session_id: control.writer_session_id,
      },
      sessions: [],
      active_containers: [],
      messaging_routes: [],
      scheduled_series: [],
      paused_series: [],
      requested_legacy_paths: requestedLegacyPaths.map(safeRelative),
      staged_paths: [],
    };
    atomicWriteLedger(ledger);
  }
  if (ledger.stage === 'created') {
    const control = getAgentGroupMemoryControl(agentGroupId);
    if (
      control?.maintenance_fence_token !== ledger.fence_token &&
      !acquireAgentGroupMemoryFence(agentGroupId, ledger.fence_owner, ledger.fence_token)
    ) {
      throw new Error(`Memory maintenance fence is already held for group: ${agentGroupId}`);
    }
    ledger.stage = 'fenced';
    atomicWriteLedger(ledger);
  }
  if (ledger.stage === 'fenced') {
    inventory(ledger);
    ledger.stage = 'inventoried';
    atomicWriteLedger(ledger);
  }
  if (ledger.stage === 'inventoried') {
    pauseScheduledSeries(ledger);
    ledger.stage = 'paused';
    atomicWriteLedger(ledger);
  }
  if (ledger.stage === 'paused') {
    await stopContainers(ledger);
    ledger.stage = 'stopped';
    atomicWriteLedger(ledger);
  }
  if (ledger.stage === 'stopped') {
    createBackup(ledger);
    ledger.stage = 'backed-up';
    atomicWriteLedger(ledger);
  }
  if (ledger.stage === 'backed-up') {
    transition(ledger, 'shadow', 'staging', null);
    ledger.stage = 'staging';
    atomicWriteLedger(ledger);
  }
  if (ledger.stage === 'staging') {
    stageLegacyPaths(ledger);
    ledger.stage = 'files-staged';
    atomicWriteLedger(ledger);
  }
  return ledger;
}

export function recordMemoryMigrationClassification(
  agentGroupId: string,
  reportRelativePath: string,
): MemoryMigrationLedger {
  const ledger = requireLedger(agentGroupId);
  if (!['files-staged', 'classified'].includes(ledger.stage))
    throw new Error('Workflow is not awaiting classification');
  const relative = safeRelative(reportRelativePath);
  const reportPath = path.join(resolveWorkspace(ledger), relative);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Partial<MemoryClassificationReport>;
  if (report.workflow_id !== ledger.workflow_id || !Array.isArray(report.entries)) {
    throw new Error('Classification report must contain this workflow_id and an entries array');
  }
  const stagedSources = new Set(ledger.staged_paths.map((entry) => entry.source));
  const classifiedSources = new Set<string>();
  for (const entry of report.entries) {
    if (!entry || typeof entry.source !== 'string' || !stagedSources.has(entry.source)) {
      throw new Error('Classification entry must reference a staged source');
    }
    classifiedSources.add(entry.source);
    if (entry.classification === 'omit') {
      if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
        throw new Error('Omitted classification entry requires a reason');
      }
      continue;
    }
    if (entry.classification !== 'standing-instruction' && entry.classification !== 'private-memory') {
      throw new Error('Unsupported memory classification');
    }
    if (typeof entry.destination !== 'string' || typeof entry.destination_sha256 !== 'string') {
      throw new Error('Materialized classification entry requires a destination and SHA-256');
    }
    const destination = safeDestinationRelative(entry.destination);
    const destinationPath = path.join(resolveWorkspace(ledger), destination);
    if (!nodeExists(destinationPath) || fs.lstatSync(destinationPath).isSymbolicLink()) {
      throw new Error(`Classification destination is unavailable or unsafe: ${destination}`);
    }
    if (sha256(destinationPath) !== entry.destination_sha256) {
      throw new Error(`Classification destination hash does not match: ${destination}`);
    }
    if (entry.classification === 'private-memory' && destination !== 'memory' && !destination.startsWith('memory/')) {
      throw new Error('Private-memory classification must target memory/');
    }
  }
  if ([...stagedSources].some((source) => !classifiedSources.has(source))) {
    throw new Error('Every staged source must be classified');
  }
  ledger.classification_report = { path: relative, sha256: sha256(reportPath), entries: report.entries.length };
  ledger.stage = 'classified';
  atomicWriteLedger(ledger);
  return ledger;
}

export async function validateMemoryMigration(agentGroupId: string): Promise<MemoryMigrationLedger> {
  const ledger = requireLedger(agentGroupId);
  if (!['classified', 'validated'].includes(ledger.stage))
    throw new Error('Classification must be recorded before validation');
  if (ledger.stage === 'validated') return ledger;
  const result = (await runMemoryValidatorContainer(agentGroupId)) as { ok?: boolean };
  ledger.validation = { ok: result.ok === true, checked_at: new Date().toISOString() };
  if (!ledger.validation.ok) {
    atomicWriteLedger(ledger);
    throw new Error('Memory validation failed; inspect the redacted validator result');
  }
  transition(ledger, 'shadow', 'validated', null);
  ledger.stage = 'validated';
  atomicWriteLedger(ledger);
  return ledger;
}

export function approveMemoryMigration(
  agentGroupId: string,
  workflowId: string,
  writerSessionId: string,
): MemoryMigrationLedger {
  const ledger = requireLedger(agentGroupId);
  if (ledger.stage !== 'validated') throw new Error('Workflow is not validated or was already approved');
  if (workflowId !== ledger.workflow_id) throw new Error('Explicit confirmation does not match the workflow ID');
  if (!ledger.sessions.some((session) => session.id === writerSessionId)) {
    throw new Error('Selected writer session does not belong to the inventoried group');
  }
  if (!ledger.classification_report) throw new Error('Classification report disappeared before approval');
  const reportPath = path.join(resolveWorkspace(ledger), ledger.classification_report.path);
  if (sha256(reportPath) !== ledger.classification_report.sha256) {
    throw new Error('Classification report changed after validation');
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as MemoryClassificationReport;
  for (const staged of ledger.staged_paths) {
    const sourcePath = path.join(resolveWorkspace(ledger), staged.source);
    if (nodeExists(sourcePath)) {
      const standing = report.entries.find(
        (entry) =>
          entry.source === staged.source &&
          entry.classification === 'standing-instruction' &&
          entry.destination === staged.source,
      );
      if (
        !standing?.destination_sha256 ||
        fs.lstatSync(sourcePath).isSymbolicLink() ||
        sha256(sourcePath) !== standing.destination_sha256
      ) {
        throw new Error(`Legacy authority was recreated before cutover: ${staged.source}`);
      }
    }
  }
  transition(ledger, 'active', 'migrated', writerSessionId);
  ledger.writer_session_id = writerSessionId;
  ledger.approved_at = new Date().toISOString();
  ledger.stage = 'approved';
  atomicWriteLedger(ledger);
  return ledger;
}

function resumeWorkflowSeries(ledger: MemoryMigrationLedger): void {
  for (const item of ledger.paused_series) {
    const db = openInboundDb(ledger.agent_group_id, item.session_id);
    try {
      resumeTask(db, item.series_id);
    } finally {
      db.close();
    }
  }
}

export function finishMemoryMigration(agentGroupId: string): MemoryMigrationLedger {
  const ledger = requireLedger(agentGroupId);
  if (['awaiting-smoke', 'completed'].includes(ledger.stage)) return ledger;
  if (ledger.stage !== 'approved') throw new Error('Workflow must be approved before it can finish');
  resumeWorkflowSeries(ledger);
  if (!releaseAgentGroupMemoryFence(agentGroupId, ledger.fence_token)) {
    const control = getAgentGroupMemoryControl(agentGroupId);
    if (control?.maintenance_fence_token !== null) {
      throw new Error('Workflow fence token no longer matches; refusing to claim completion');
    }
  }
  ledger.stage = 'awaiting-smoke';
  atomicWriteLedger(ledger);
  return ledger;
}

const REQUIRED_SMOKE_CHECKS = ['recall', 'correction', 'clear', 'compact', 'provider-switch'];

export function recordMemoryMigrationSmokeTests(
  agentGroupId: string,
  reportRelativePath: string,
): MemoryMigrationLedger {
  const ledger = requireLedger(agentGroupId);
  if (ledger.stage === 'completed') return ledger;
  if (ledger.stage !== 'awaiting-smoke') throw new Error('Finish the approved maintenance window before smoke tests');
  const relative = safeRelative(reportRelativePath);
  const reportPath = path.join(resolveWorkspace(ledger), relative);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
    workflow_id?: string;
    checks?: Record<string, unknown>;
  };
  if (report.workflow_id !== ledger.workflow_id || !report.checks)
    throw new Error('Smoke report does not match workflow');
  const failed = REQUIRED_SMOKE_CHECKS.filter((name) => report.checks?.[name] !== true);
  if (failed.length) throw new Error(`Smoke report is missing passing checks: ${failed.join(', ')}`);
  ledger.smoke_report = { path: relative, sha256: sha256(reportPath), checks: REQUIRED_SMOKE_CHECKS };
  ledger.completed_at = new Date().toISOString();
  ledger.stage = 'completed';
  atomicWriteLedger(ledger);
  return ledger;
}

export async function rollbackMemoryMigration(
  agentGroupId: string,
  workflowId: string,
): Promise<MemoryMigrationLedger> {
  const ledger = requireLedger(agentGroupId);
  if (workflowId !== ledger.workflow_id) throw new Error('Explicit confirmation does not match the workflow ID');
  if (ledger.stage === 'rolled-back') throw new Error(`Cannot roll back workflow in ${ledger.stage}`);
  const fencedControl = getAgentGroupMemoryControl(agentGroupId);
  if (!fencedControl) throw new Error('Memory control row disappeared');
  if (fencedControl.maintenance_fence_token === null) {
    if (!acquireAgentGroupMemoryFence(agentGroupId, ledger.fence_owner, ledger.fence_token)) {
      throw new Error('Could not reacquire the workflow fence for rollback');
    }
  } else if (fencedControl.maintenance_fence_token !== ledger.fence_token) {
    throw new Error('A different maintenance workflow currently holds the group fence');
  }
  await stopContainers(ledger);
  const workspace = resolveWorkspace(ledger);
  const postApproval = ['approved', 'awaiting-smoke', 'completed', 'rolling-back-post'].includes(ledger.stage);
  let displaced: string | undefined;
  if (postApproval) {
    if (!ledger.backup || sha256(ledger.backup.path) !== ledger.backup.sha256)
      throw new Error('Verified backup is unavailable');
    displaced = `${workspace}.rollback-displaced-${ledger.workflow_id}`;
    if (ledger.stage === 'approved') {
      if (fs.existsSync(displaced)) throw new Error(`Rollback destination collision: ${displaced}`);
      ledger.rollback = { kind: 'post-approval', displaced_workspace: displaced, at: new Date().toISOString() };
      ledger.stage = 'rolling-back-post';
      atomicWriteLedger(ledger);
    }
    if (!fs.existsSync(displaced)) fs.renameSync(workspace, displaced);
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    execFileSync('tar', ['--extract', '--file', ledger.backup.path, '--directory', GROUPS_DIR], { stdio: 'pipe' });
  } else {
    if (ledger.stage !== 'rolling-back-pre') {
      ledger.rollback = { kind: 'pre-approval', at: new Date().toISOString() };
      ledger.stage = 'rolling-back-pre';
      atomicWriteLedger(ledger);
    }
    for (const entry of [...ledger.staged_paths].reverse()) {
      const source = path.join(workspace, entry.source);
      const staged = path.join(workspace, entry.staged);
      if (nodeExists(source)) throw new Error(`Rollback refuses to overwrite: ${entry.source}`);
      if (nodeExists(staged)) {
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.renameSync(staged, source);
      }
    }
  }
  const control = getAgentGroupMemoryControl(agentGroupId);
  if (!control) throw new Error('Memory control row disappeared');
  if (
    control.mode !== ledger.prior_control.mode ||
    control.migration_state !== ledger.prior_control.migration_state ||
    control.writer_session_id !== ledger.prior_control.writer_session_id
  ) {
    restoreAgentGroupMemoryControl(agentGroupId, control.version, ledger.fence_token, {
      mode: ledger.prior_control.mode,
      migrationState: ledger.prior_control.migration_state,
      writerSessionId: ledger.prior_control.writer_session_id,
    });
  }
  resumeWorkflowSeries(ledger);
  if (!releaseAgentGroupMemoryFence(agentGroupId, ledger.fence_token)) {
    const current = getAgentGroupMemoryControl(agentGroupId);
    if (current?.maintenance_fence_token !== null) throw new Error('Workflow fence release failed');
  }
  ledger.stage = 'rolled-back';
  atomicWriteLedger(ledger);
  return ledger;
}
