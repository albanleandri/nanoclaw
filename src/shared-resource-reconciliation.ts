import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { isContainerRunning } from './container-runner.js';
import { getAllContainerConfigs } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import {
  ensureSharedResourceControl,
  getSharedResourceControl,
  transitionSharedResourceControl,
} from './db/shared-resource-control.js';
import { runSharedMemoryValidatorContainer } from './memory-operator.js';

const REPORT_MAX_BYTES = 1024 * 1024;

function safeName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || name === 'docs') {
    throw new Error(`Invalid shared resource name: ${name}`);
  }
  return name;
}

function resourceRoot(name: string): string {
  const root = path.join(GROUPS_DIR, 'shared', safeName(name));
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Shared resource root must be a real directory');
  return root;
}

function grantedGroups(name: string): string[] {
  return getAllContainerConfigs()
    .filter((row) => {
      const grants = JSON.parse(row.shared_resources) as unknown;
      return Array.isArray(grants) && grants.includes(name);
    })
    .map((row) => row.agent_group_id)
    .sort();
}

function requireGrantedGroupsStopped(grants: string[]): void {
  const running = grants.flatMap((agentGroupId) =>
    getSessionsByAgentGroup(agentGroupId)
      .filter((session) => isContainerRunning(session.id))
      .map((session) => session.id),
  );
  if (running.length) throw new Error(`Stop all granted-group containers before reconciliation: ${running.join(', ')}`);
}

function inventoryNodes(root: string): Array<{ path: string; kind: string; bytes?: number }> {
  const nodes: Array<{ path: string; kind: string; bytes?: number }> = [];
  const walk = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (nodes.length >= 5000) throw new Error('Shared resource inventory exceeds 5,000 nodes');
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      const relative = path.relative(root, absolute);
      const kind = stat.isDirectory()
        ? 'directory'
        : stat.isFile()
          ? 'regular'
          : stat.isSymbolicLink()
            ? 'symlink'
            : 'special';
      nodes.push({ path: relative, kind, ...(stat.isFile() ? { bytes: stat.size } : {}) });
      if (stat.isDirectory()) walk(absolute);
    }
  };
  walk(root);
  return nodes;
}

function hashFile(file: string): string {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > REPORT_MAX_BYTES)
    throw new Error('Reconciliation report must be a bounded regular file');
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function prepareSharedResourceReconciliation(resourceName: string, ownerAgentGroupId: string): unknown {
  const name = safeName(resourceName);
  const root = resourceRoot(name);
  const grants = grantedGroups(name);
  if (!grants.includes(ownerAgentGroupId))
    throw new Error('Selected owner must already have an explicit resource grant');
  requireGrantedGroupsStopped(grants);
  ensureSharedResourceControl(name);
  const current = getSharedResourceControl(name)!;
  if (current.reconciliation_state === 'pilot') {
    transitionSharedResourceControl(name, current.version, 'pilot', {
      state: 'reconciling',
      ownerAgentGroupId,
    });
  } else if (current.reconciliation_state !== 'reconciling' || current.owner_agent_group_id !== ownerAgentGroupId) {
    throw new Error(`Shared resource is already ${current.reconciliation_state} with a different workflow`);
  }
  const nodes = inventoryNodes(root);
  const legacyAuthorities: Array<{ scope: string; path: string; kind: string; bytes?: number }> = nodes
    .filter((node) => /(^|\/)(MEMORY\.md|CLAUDE\.local\.md)$/.test(node.path))
    .map((node) => ({ scope: 'shared', ...node }));
  for (const agentGroupId of grants) {
    const group = getAgentGroup(agentGroupId);
    if (!group) continue;
    for (const relative of ['CLAUDE.local.md', 'memory/index.md']) {
      const candidate = path.join(GROUPS_DIR, group.folder, relative);
      try {
        const stat = fs.lstatSync(candidate);
        legacyAuthorities.push({
          scope: `agent-group:${agentGroupId}`,
          path: relative,
          kind: stat.isFile() ? 'regular' : stat.isSymbolicLink() ? 'symlink' : 'special',
          ...(stat.isFile() ? { bytes: stat.size } : {}),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  const inventory = {
    schema_version: 1,
    resource_name: name,
    owner_agent_group_id: ownerAgentGroupId,
    granted_agent_group_ids: grants,
    nodes,
    legacy_authorities: legacyAuthorities,
    created_at: new Date().toISOString(),
  };
  const output = path.join(DATA_DIR, 'shared-resource-reconciliation', name, 'inventory.json');
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
  return { ...getSharedResourceControl(name), inventory_path: output, ...inventory };
}

export async function validateSharedResourceReconciliation(resourceName: string, reportPath: string): Promise<unknown> {
  const name = safeName(resourceName);
  const current = getSharedResourceControl(name);
  if (!current || current.reconciliation_state !== 'reconciling' || !current.owner_agent_group_id) {
    throw new Error('Shared resource is not awaiting reconciliation validation');
  }
  const absoluteReport = path.resolve(reportPath);
  const relativeReport = path.relative(DATA_DIR, absoluteReport);
  if (relativeReport.startsWith('..') || path.isAbsolute(relativeReport)) {
    throw new Error('Reconciliation report must be stored under the ignored data directory');
  }
  const reportHash = hashFile(absoluteReport);
  const report = JSON.parse(fs.readFileSync(absoluteReport, 'utf8')) as {
    resource_name?: string;
    entries?: Array<{ source?: string; classification?: string; destination?: string; reason?: string }>;
    pilot_markers_removed?: boolean;
  };
  const allowed = new Set(['private-instruction', 'shared-evidence', 'omit']);
  if (
    report.resource_name !== name ||
    !Array.isArray(report.entries) ||
    report.entries.some((entry) => {
      if (typeof entry.source !== 'string' || !allowed.has(String(entry.classification))) return true;
      return entry.classification === 'omit'
        ? typeof entry.reason !== 'string' || !entry.reason.trim()
        : typeof entry.destination !== 'string' || !entry.destination.trim();
    })
  ) {
    throw new Error('Invalid source-to-destination reconciliation report');
  }
  const validation = (await runSharedMemoryValidatorContainer(name)) as { ok?: boolean };
  if (validation.ok !== true) throw new Error('Shared resource validation failed');
  return transitionSharedResourceControl(name, current.version, 'reconciling', {
    state: 'validated',
    ownerAgentGroupId: current.owner_agent_group_id,
    classificationReportPath: relativeReport,
    classificationReportSha256: reportHash,
    validationReportJson: JSON.stringify(validation),
  });
}

export function approveSharedResourceReconciliation(
  resourceName: string,
  expectedVersion: number,
  confirmation: string,
): unknown {
  const name = safeName(resourceName);
  const current = getSharedResourceControl(name);
  if (!current || current.reconciliation_state !== 'validated' || !current.owner_agent_group_id) {
    throw new Error('Shared resource is not validated');
  }
  if (confirmation !== name || expectedVersion !== current.version) {
    throw new Error('Approval confirmation or expected version does not match');
  }
  requireGrantedGroupsStopped(grantedGroups(name));
  const reportPath = path.join(DATA_DIR, current.classification_report_path!);
  if (hashFile(reportPath) !== current.classification_report_sha256) {
    throw new Error('Classification report changed after validation');
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as { pilot_markers_removed?: boolean };
  if (report.pilot_markers_removed !== true) {
    throw new Error('Report must attest that mirror/pilot markers were removed');
  }
  return transitionSharedResourceControl(name, current.version, 'validated', {
    state: 'reconciled',
    ownerAgentGroupId: current.owner_agent_group_id,
    approvedAt: new Date().toISOString(),
  });
}

export function sharedResourceReconciliationStatus(resourceName: string): unknown {
  const name = safeName(resourceName);
  const control = getSharedResourceControl(name);
  const grants = grantedGroups(name);
  return {
    resource_name: name,
    control: control ?? null,
    granted_agent_group_ids: grants,
    effective_access: grants.map((agentGroupId) => ({
      agent_group_id: agentGroupId,
      access:
        control?.reconciliation_state === 'reconciled' && control.owner_agent_group_id === agentGroupId
          ? 'read-write'
          : 'read-only',
    })),
  };
}
