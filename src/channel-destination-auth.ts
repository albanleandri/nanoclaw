import { getDb, hasTable } from './db/connection.js';
import { getMessagingGroupByPlatform } from './db/messaging-groups.js';
import type { MessagingGroup, Session } from './types.js';

/**
 * Resolve a channel route through host-owned messaging-group state and assert
 * that the source agent is allowed to use it.
 */
export function authorizeChannelDestination(session: Session, channelType: string, platformId: string): MessagingGroup {
  const messagingGroup = getMessagingGroupByPlatform(channelType, platformId);
  if (!messagingGroup) {
    throw new Error(`unknown messaging group for ${channelType}/${platformId}`);
  }

  if (session.messaging_group_id === messagingGroup.id) return messagingGroup;

  // Keep the core-without-module compatibility behavior used by ordinary
  // outbound delivery. When the destination module is installed, fail closed.
  if (hasTable(getDb(), 'agent_destinations')) {
    const allowed = getDb()
      .prepare(
        'SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
      )
      .get(session.agent_group_id, 'channel', messagingGroup.id);
    if (!allowed) {
      throw new Error(
        `unauthorized channel destination: ${session.agent_group_id} cannot send to ${messagingGroup.channel_type}/${messagingGroup.platform_id}`,
      );
    }
  }

  return messagingGroup;
}
