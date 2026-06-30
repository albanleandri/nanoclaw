import type Database from 'better-sqlite3';

import '../capabilities/builtins/index.js';
import { requireCapability } from '../capabilities/capability-registry.js';
import { registerDeliveryAction } from '../delivery.js';
import type { Session } from '../types.js';
import { appendCapabilityAuditEvent, type CapabilityAuditEventType } from './capability-events.js';

const EVENTS = new Set<CapabilityAuditEventType>([
  'requested',
  'authorized',
  'denied',
  'started',
  'succeeded',
  'failed',
  'cancelled',
]);

export async function handleCapabilityAudit(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const capabilityId = String(content.capabilityId ?? '');
  const manifest = requireCapability(capabilityId);
  const eventType = content.eventType as CapabilityAuditEventType;
  if (!EVENTS.has(eventType)) throw new Error('Invalid capability audit event type');
  const capabilityVersion = Number(content.capabilityVersion);
  if (capabilityVersion !== manifest.version) throw new Error('Capability audit version mismatch');
  const entrypoint = String(content.entrypoint ?? '');
  if (!manifest.adapters.some((candidate) => candidate.entrypoint === entrypoint)) {
    throw new Error('Capability audit entrypoint mismatch');
  }
  appendCapabilityAuditEvent({
    eventId: String(content.eventId ?? ''),
    invocationId: String(content.invocationId ?? ''),
    seq: Number(content.seq),
    eventType,
    agentGroupId: session.agent_group_id,
    sessionId: session.id,
    runtimeId: typeof content.runtimeId === 'string' ? content.runtimeId : undefined,
    capabilityId,
    capabilityVersion,
    adapter: String(content.adapter ?? 'mcp'),
    entrypoint,
    argsSha256: String(content.argsSha256 ?? ''),
    decision: typeof content.decision === 'string' ? content.decision : undefined,
    resultClass: typeof content.resultClass === 'string' ? content.resultClass : undefined,
    durationMs: typeof content.durationMs === 'number' ? content.durationMs : undefined,
    createdAt: typeof content.createdAt === 'string' ? content.createdAt : new Date().toISOString(),
  });
}

registerDeliveryAction('capability_audit', handleCapabilityAudit);
