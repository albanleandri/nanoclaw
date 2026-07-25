import { getDb } from './connection.js';

export type SharedResourceReconciliationState = 'pilot' | 'reconciling' | 'validated' | 'reconciled';

export interface SharedResourceControl {
  resource_name: string;
  owner_agent_group_id: string | null;
  reconciliation_state: SharedResourceReconciliationState;
  classification_report_path: string | null;
  classification_report_sha256: string | null;
  validation_report_json: string | null;
  approved_at: string | null;
  version: number;
  updated_at: string;
}

export function getSharedResourceControl(resourceName: string): SharedResourceControl | undefined {
  return getDb().prepare('SELECT * FROM shared_resource_control WHERE resource_name = ?').get(resourceName) as
    | SharedResourceControl
    | undefined;
}

export function getAllSharedResourceControls(): SharedResourceControl[] {
  return getDb()
    .prepare('SELECT * FROM shared_resource_control ORDER BY resource_name')
    .all() as SharedResourceControl[];
}

export function ensureSharedResourceControl(resourceName: string, now = new Date().toISOString()): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO shared_resource_control (
        resource_name, reconciliation_state, version, updated_at
      ) VALUES (?, 'pilot', 1, ?)`,
    )
    .run(resourceName, now);
}

export function transitionSharedResourceControl(
  resourceName: string,
  expectedVersion: number,
  expectedState: SharedResourceReconciliationState,
  input: {
    state: SharedResourceReconciliationState;
    ownerAgentGroupId: string | null;
    classificationReportPath?: string | null;
    classificationReportSha256?: string | null;
    validationReportJson?: string | null;
    approvedAt?: string | null;
  },
  now = new Date().toISOString(),
): SharedResourceControl {
  const legal = new Set(['pilot->reconciling', 'reconciling->validated', 'validated->reconciled']);
  if (!legal.has(`${expectedState}->${input.state}`)) {
    throw new Error(`Invalid shared-resource reconciliation transition: ${expectedState}->${input.state}`);
  }
  if (input.state === 'reconciled' && (!input.ownerAgentGroupId || !input.approvedAt)) {
    throw new Error('Reconciled shared resources require an owner and explicit approval time');
  }
  const owner = input.ownerAgentGroupId;
  if (owner) {
    const group = getDb().prepare('SELECT 1 FROM agent_groups WHERE id = ?').get(owner);
    if (!group) throw new Error(`Shared-resource owner group not found: ${owner}`);
  }
  const result = getDb()
    .prepare(
      `UPDATE shared_resource_control
       SET reconciliation_state = ?,
           owner_agent_group_id = ?,
           classification_report_path = COALESCE(?, classification_report_path),
           classification_report_sha256 = COALESCE(?, classification_report_sha256),
           validation_report_json = COALESCE(?, validation_report_json),
           approved_at = ?,
           version = version + 1,
           updated_at = ?
       WHERE resource_name = ?
         AND version = ?
         AND reconciliation_state = ?`,
    )
    .run(
      input.state,
      owner,
      input.classificationReportPath ?? null,
      input.classificationReportSha256 ?? null,
      input.validationReportJson ?? null,
      input.approvedAt ?? null,
      now,
      resourceName,
      expectedVersion,
      expectedState,
    );
  if (result.changes !== 1) throw new Error(`Shared-resource reconciliation conflict: ${resourceName}`);
  return getSharedResourceControl(resourceName)!;
}
