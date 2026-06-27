import { getDb } from './connection.js';

export interface ScheduleAdminGrant {
  admin_agent_group_id: string;
  owner_agent_group_id: string;
  created_at: string;
  created_by: string | null;
}

export function grantScheduleAdmin(
  adminAgentGroupId: string,
  ownerAgentGroupId: string,
  createdBy?: string,
): ScheduleAdminGrant {
  if (adminAgentGroupId === ownerAgentGroupId) throw new Error('Schedule owner does not need a self-grant');
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO schedule_admin_grants
       (admin_agent_group_id, owner_agent_group_id, created_at, created_by)
       VALUES (?, ?, ?, ?)`,
    )
    .run(adminAgentGroupId, ownerAgentGroupId, new Date().toISOString(), createdBy ?? null);
  return getScheduleAdminGrants(adminAgentGroupId).find((grant) => grant.owner_agent_group_id === ownerAgentGroupId)!;
}

export function revokeScheduleAdmin(adminAgentGroupId: string, ownerAgentGroupId: string): boolean {
  return (
    getDb()
      .prepare('DELETE FROM schedule_admin_grants WHERE admin_agent_group_id = ? AND owner_agent_group_id = ?')
      .run(adminAgentGroupId, ownerAgentGroupId).changes > 0
  );
}

export function getScheduleAdminGrants(adminAgentGroupId: string): ScheduleAdminGrant[] {
  return getDb()
    .prepare('SELECT * FROM schedule_admin_grants WHERE admin_agent_group_id = ? ORDER BY owner_agent_group_id')
    .all(adminAgentGroupId) as ScheduleAdminGrant[];
}

export function listScheduleAdminGrants(): ScheduleAdminGrant[] {
  return getDb()
    .prepare('SELECT * FROM schedule_admin_grants ORDER BY admin_agent_group_id, owner_agent_group_id')
    .all() as ScheduleAdminGrant[];
}

export function isScheduleAdminAuthorized(adminAgentGroupId: string, ownerAgentGroupId: string): boolean {
  return Boolean(
    getDb()
      .prepare(
        'SELECT 1 FROM schedule_admin_grants WHERE admin_agent_group_id = ? AND owner_agent_group_id = ? LIMIT 1',
      )
      .get(adminAgentGroupId, ownerAgentGroupId),
  );
}
