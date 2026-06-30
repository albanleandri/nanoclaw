import { createHash, randomUUID } from 'crypto';

import { getConfig } from './config.js';
import { writeMessageOut } from './db/messages-out.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function omitSensitiveFields(value: unknown, sensitiveFields: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => omitSensitiveFields(item, sensitiveFields));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !sensitiveFields.has(key))
      .map(([key, item]) => [key, omitSensitiveFields(item, sensitiveFields)]),
  );
}

export interface AuditInvocation {
  invocationId: string;
  argsSha256: string;
  startedAt: number;
  emit(eventType: string, seq: number, extra?: Record<string, unknown>): void;
}

export function beginCapabilityAudit(
  capabilityId: string,
  capabilityVersion: number,
  entrypoint: string,
  args: Record<string, unknown>,
  sensitiveFields: string[] = [],
): AuditInvocation {
  const invocationId = randomUUID();
  const redactedArgs = omitSensitiveFields(args, new Set(sensitiveFields));
  const argsSha256 = createHash('sha256').update(canonical(redactedArgs)).digest('hex');
  const startedAt = Date.now();
  const emit = (eventType: string, seq: number, extra: Record<string, unknown> = {}): void => {
    let runtimeId: string | undefined;
    try {
      runtimeId = getConfig().sessionRuntimePlan?.runtime.runtimeId;
    } catch {
      runtimeId = undefined;
    }
    writeMessageOut({
      id: `capability-audit:${invocationId}:${seq}`,
      kind: 'system',
      content: JSON.stringify({
        action: 'capability_audit',
        eventId: `capability-audit:${invocationId}:${seq}`,
        invocationId,
        seq,
        eventType,
        runtimeId,
        capabilityId,
        capabilityVersion,
        adapter: 'mcp',
        entrypoint,
        argsSha256,
        createdAt: new Date().toISOString(),
        ...extra,
      }),
    });
  };
  emit('requested', 1);
  emit('started', 2, { decision: 'runner-handler' });
  return { invocationId, argsSha256, startedAt, emit };
}
