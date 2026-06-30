import { AUXILIARY_ROLES, type AuxiliaryRole, type AuxiliaryTarget } from '../auxiliary/types.js';
import { getDb } from './connection.js';
import { getProviderProfile } from './provider-profiles.js';

interface AuxiliaryRouteRow {
  agent_group_id: string;
  role: AuxiliaryRole;
  target_kind: AuxiliaryTarget['kind'];
  provider_profile_id: string | null;
  target_agent_group_id: string | null;
  model: string | null;
  updated_at: string;
}

function rowTarget(row: AuxiliaryRouteRow): AuxiliaryTarget {
  if (row.target_kind === 'endpoint-profile') {
    return { kind: row.target_kind, providerProfileId: row.provider_profile_id!, model: row.model ?? undefined };
  }
  if (row.target_kind === 'agent') return { kind: row.target_kind, agentGroupId: row.target_agent_group_id! };
  return { kind: row.target_kind };
}

export function getAuxiliaryRoute(agentGroupId: string, role: AuxiliaryRole): AuxiliaryTarget {
  const row = getDb()
    .prepare('SELECT * FROM auxiliary_routes WHERE agent_group_id = ? AND role = ?')
    .get(agentGroupId, role) as AuxiliaryRouteRow | undefined;
  return row ? rowTarget(row) : { kind: 'disabled' };
}

export function listAuxiliaryRoutes(agentGroupId: string): Array<{ role: AuxiliaryRole; target: AuxiliaryTarget }> {
  return (
    getDb()
      .prepare('SELECT * FROM auxiliary_routes WHERE agent_group_id = ? ORDER BY role')
      .all(agentGroupId) as AuxiliaryRouteRow[]
  ).map((row) => ({ role: row.role, target: rowTarget(row) }));
}

export function setAuxiliaryRoute(agentGroupId: string, role: AuxiliaryRole, target: AuxiliaryTarget): void {
  if (!(AUXILIARY_ROLES as readonly string[]).includes(role)) throw new Error(`Unknown auxiliary role: ${role}`);
  if (target.kind === 'endpoint-profile') {
    const profile = getProviderProfile(target.providerProfileId);
    if (!profile || profile.enabled !== 1)
      throw new Error(`Auxiliary provider profile unavailable: ${target.providerProfileId}`);
  }
  if (target.kind === 'agent') {
    const exists = getDb().prepare('SELECT 1 FROM agent_groups WHERE id = ?').get(target.agentGroupId);
    if (!exists) throw new Error(`Auxiliary target agent not found: ${target.agentGroupId}`);
  }
  getDb()
    .prepare(
      `INSERT INTO auxiliary_routes
       (agent_group_id, role, target_kind, provider_profile_id, target_agent_group_id, model, updated_at)
       VALUES (@agentGroupId, @role, @kind, @profileId, @targetAgentGroupId, @model, @updatedAt)
       ON CONFLICT(agent_group_id, role) DO UPDATE SET
         target_kind=excluded.target_kind,
         provider_profile_id=excluded.provider_profile_id,
         target_agent_group_id=excluded.target_agent_group_id,
         model=excluded.model,
         updated_at=excluded.updated_at`,
    )
    .run({
      agentGroupId,
      role,
      kind: target.kind,
      profileId: target.kind === 'endpoint-profile' ? target.providerProfileId : null,
      targetAgentGroupId: target.kind === 'agent' ? target.agentGroupId : null,
      model: target.kind === 'endpoint-profile' ? (target.model ?? null) : null,
      updatedAt: new Date().toISOString(),
    });
}
