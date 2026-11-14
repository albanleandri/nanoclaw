/**
 * Unknown-sender approval flow.
 *
 * When `messaging_groups.unknown_sender_policy = 'request_approval'` and a
 * non-member writes into a wired chat, the access gate drops the routing
 * attempt and calls `requestSenderApproval` to:
 *
 *   1. Pick an eligible approver (owner / admin of the agent group).
 *   2. Open / reuse a DM to that approver on a reachable channel.
 *   3. Deliver an Approve / Deny card.
 *   4. Record a pending_sender_approvals row that holds the original message
 *      so it can be re-routed on approve.
 *
 * On approve: the handler in index.ts adds an agent_group_members row for
 * the sender and re-invokes routeInbound with the stored event — the second
 * routing attempt passes the gate because the user is now a member.
 *
 * Failure modes (logged + row NOT created, so the dedup gate lets a future
 * attempt try again):
 *   - No eligible approver in user_roles — fresh install, no owner yet.
 *   - Approver has no reachable DM (no user_dms row + channel can't
 *     openDM) — e.g. owner hasn't registered on any channel we're wired to.
 *   - Delivery adapter missing.
 *
 * Dedup: `pending_sender_approvals` has UNIQUE(messaging_group_id,
 * sender_identity). A retry / rapid second message from the same unknown
 * sender is silently dropped (no duplicate card sent).
 */
import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import {
  clearDeclineStamp,
  createPendingSenderApproval,
  getDeclineStampAt,
  hasInFlightSenderApproval,
  upsertDeclineStamp,
} from './db/pending-sender-approvals.js';
import { getOwners } from './db/user-roles.js';
import { getUser } from './db/users.js';
import { AGENT_ACCESS_SCOPE_WARNING } from './channel-approval.js';

const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Allow', selectedLabel: '✅ Allowed', value: 'approve' },
  { label: 'Deny', selectedLabel: '❌ Denied', value: 'reject' },
];

function generateId(): string {
  return `nsa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface RequestSenderApprovalInput {
  messagingGroupId: string;
  agentGroupId: string;
  senderIdentity: string; // namespaced user id (channel_type:handle)
  senderName: string | null;
  event: InboundEvent;
}

export async function requestSenderApproval(input: RequestSenderApprovalInput): Promise<void> {
  const { messagingGroupId, agentGroupId, senderIdentity, senderName, event } = input;

  // A policy flip from decline_notify leaves a stamp on the same UNIQUE key.
  clearDeclineStamp(messagingGroupId, senderIdentity);

  // In-flight dedup: don't spam the admin if the same unknown sender
  // retries while a card is already pending.
  if (hasInFlightSenderApproval(messagingGroupId, senderIdentity)) {
    log.debug('Unknown-sender approval already in flight — dropping retry', {
      messagingGroupId,
      senderIdentity,
    });
    return;
  }

  const approvers = pickApprover(agentGroupId);
  if (approvers.length === 0) {
    log.warn('Unknown-sender approval skipped — no owner or admin configured', {
      messagingGroupId,
      agentGroupId,
      senderIdentity,
    });
    return;
  }

  const originMg = getMessagingGroup(messagingGroupId);
  const originChannelType = originMg?.channel_type ?? '';
  const target = await pickApprovalDelivery(approvers, originChannelType);
  if (!target) {
    log.warn('Unknown-sender approval skipped — no DM channel for any approver', {
      messagingGroupId,
      agentGroupId,
      senderIdentity,
    });
    return;
  }

  const approvalId = generateId();
  const senderDisplay = senderName && senderName.length > 0 ? senderName : senderIdentity;
  const originName = originMg?.name ?? `a ${originChannelType} channel`;

  const title = '👤 New sender';
  const question = `${senderDisplay} wants to talk to your agent in ${originName}. ${AGENT_ACCESS_SCOPE_WARNING} Allow?`;
  const options = normalizeOptions(APPROVAL_OPTIONS);

  createPendingSenderApproval({
    id: approvalId,
    messaging_group_id: messagingGroupId,
    agent_group_id: agentGroupId,
    sender_identity: senderIdentity,
    sender_name: senderName,
    original_message: JSON.stringify(event),
    approver_user_id: target.userId,
    created_at: new Date().toISOString(),
    title,
    options_json: JSON.stringify(options),
  });

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    // Without a delivery adapter, the card can't be sent. Log + leave the
    // row in place so the admin can see it via DB or manual tooling; the
    // dedup gate will suppress further cards until it's cleared.
    log.error('Unknown-sender approval row created but no delivery adapter is wired', {
      approvalId,
    });
    return;
  }

  try {
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: approvalId,
        title,
        question,
        options,
      }),
    );
    log.info('Unknown-sender approval card delivered', {
      approvalId,
      senderIdentity,
      approver: target.userId,
      messagingGroupId,
      agentGroupId,
    });
  } catch (err) {
    log.error('Unknown-sender approval card delivery failed', {
      approvalId,
      err,
    });
  }
}

/**
 * Option value the admin clicked that means "allow" — shared with the
 * response handler so the two sides can't drift.
 */
export const APPROVE_VALUE = 'approve';
export const REJECT_VALUE = 'reject';

export const DECLINE_NOTIFY_DEDUPE_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_SENDER_KEY = 'unknown';

function ownerDisplayName(): string | null {
  for (const owner of getOwners()) {
    const name = getUser(owner.user_id)?.display_name;
    if (name) return name;
  }
  return null;
}

export interface DeclineAndNotifyInput {
  messagingGroupId: string;
  agentGroupId: string | null;
  senderIdentity: string | null;
  senderName: string | null;
  event: InboundEvent;
  dedupeKey?: string;
  declineText?: string;
  fyiText?: string;
}

/** Politely decline an unknown DM and send a plain-text owner FYI, without granting access. */
export async function declineAndNotify(input: DeclineAndNotifyInput): Promise<void> {
  const { messagingGroupId, agentGroupId, senderIdentity, senderName, event } = input;
  const senderKey = input.dedupeKey ?? senderIdentity ?? UNKNOWN_SENDER_KEY;
  const stampedAt = getDeclineStampAt(messagingGroupId, senderKey);
  if (stampedAt && Date.now() - new Date(stampedAt).getTime() < DECLINE_NOTIFY_DEDUPE_MS) {
    log.debug('decline_notify deduped — declined within the last 24h', { messagingGroupId, senderIdentity });
    return;
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.error('decline_notify skipped — no delivery adapter is wired', { messagingGroupId });
    return;
  }

  const stampAgentGroupId = agentGroupId ?? getAllAgentGroups()[0]?.id;
  if (stampAgentGroupId) {
    upsertDeclineStamp({
      messaging_group_id: messagingGroupId,
      agent_group_id: stampAgentGroupId,
      sender_identity: senderKey,
      sender_name: senderName,
      original_message: JSON.stringify(event),
    });
  }

  const originMg = getMessagingGroup(messagingGroupId);
  const declineText =
    input.declineText ?? `I'm ${ownerDisplayName() ?? 'my owner'}'s personal agent — I can't help you directly.`;
  try {
    await adapter.deliver(event.channelType, event.platformId, null, 'chat-sdk', JSON.stringify({ text: declineText }));
  } catch (err) {
    log.warn('decline_notify: decline delivery failed', { messagingGroupId, err });
  }

  const approvers = pickApprover(agentGroupId);
  const target = await pickApprovalDelivery(approvers, originMg?.channel_type ?? event.channelType);
  if (!target) {
    log.warn('decline_notify FYI skipped — no reachable owner or admin', { messagingGroupId, senderIdentity });
    return;
  }

  const senderDisplay = senderName || senderIdentity || 'An unknown sender';
  const who =
    senderIdentity && senderDisplay !== senderIdentity ? `${senderDisplay} (${senderIdentity})` : senderDisplay;
  const fyiText =
    input.fyiText ??
    `FYI: ${who} DMed your agent on ${event.channelType} — I sent a polite decline. Allow them with \`ncl members add\`.`;
  try {
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({ text: fyiText }),
    );
    log.info('decline_notify handled — decline sent, owner notified', {
      messagingGroupId,
      senderIdentity,
      notified: target.userId,
    });
  } catch (err) {
    log.error('decline_notify: owner FYI delivery failed', { messagingGroupId, err });
  }
}
