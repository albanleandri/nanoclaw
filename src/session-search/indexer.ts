import { log } from '../log.js';
import { normalizeSessionText } from './normalize.js';
import { upsertSessionSearchDocument } from './store.js';

export function indexSessionMessage(input: {
  agentGroupId: string;
  sessionId: string;
  sourceKind: 'inbound' | 'outbound';
  messageId: string;
  timestamp: string;
  kind: string;
  channelType?: string | null;
  content: string;
}): boolean {
  const normalized = normalizeSessionText({
    direction: input.sourceKind,
    kind: input.kind,
    channelType: input.channelType,
    content: input.content,
  });
  if (!normalized) return false;
  upsertSessionSearchDocument({
    agentGroupId: input.agentGroupId,
    sessionId: input.sessionId,
    sourceKind: input.sourceKind,
    messageId: input.messageId,
    role: normalized.role,
    timestamp: input.timestamp,
    content: normalized.text,
  });
  return true;
}

export function tryIndexSessionMessage(input: Parameters<typeof indexSessionMessage>[0]): boolean {
  try {
    return indexSessionMessage(input);
  } catch (error) {
    // Projection failure is intentionally repairable and must not block delivery.
    log.warn('Session search indexing failed; reindex can repair it', {
      sessionId: input.sessionId,
      messageId: input.messageId,
      error,
    });
    return false;
  }
}
