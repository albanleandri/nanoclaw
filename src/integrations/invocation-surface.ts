import {
  getIntegrationProfileRow,
  hasIntegrationProfileGrant,
  listGrantedIntegrationProfileRows,
  listIntegrationProfileRows,
} from '../db/integration-profiles.js';
import type { CallerContext } from '../cli/frame.js';
import {
  hostIntegrationInvoker,
  HostIntegrationInvocationError,
  type HostIntegrationInvocationResult,
} from './invoker.js';

export interface InvokeGrantedHostIntegrationInput {
  caller: CallerContext;
  adapterId: string;
  adapterVersion: number;
  operation: string;
  profile?: string;
  input: unknown;
  signal?: AbortSignal;
}

export async function invokeGrantedHostIntegration(
  request: InvokeGrantedHostIntegrationInput,
): Promise<HostIntegrationInvocationResult> {
  const profile = selectProfile(request);
  return hostIntegrationInvoker.invoke({
    caller: request.caller,
    profile,
    operation: request.operation,
    input: request.input,
    signal: request.signal,
  });
}

function selectProfile(request: InvokeGrantedHostIntegrationInput): string {
  if (!Number.isInteger(request.adapterVersion) || request.adapterVersion < 1) {
    throw new HostIntegrationInvocationError('not_authorized', 'authorization');
  }
  if (request.profile) return selectExplicitProfile(request);

  const rows =
    request.caller.caller === 'agent'
      ? listGrantedIntegrationProfileRows(
          request.caller.agentGroupId,
          request.adapterId,
          request.adapterVersion,
          request.operation,
        )
      : listIntegrationProfileRows().filter(
          (row) => row.adapter_id === request.adapterId && row.adapter_version === request.adapterVersion,
        );
  if (rows.length !== 1) {
    throw new HostIntegrationInvocationError(
      rows.length === 0 ? 'not_authorized' : 'invalid_configuration',
      'authorization',
    );
  }
  return rows[0]!.id;
}

function selectExplicitProfile(request: InvokeGrantedHostIntegrationInput): string {
  const row = getIntegrationProfileRow(request.profile!);
  if (request.caller.caller === 'agent') {
    const granted = hasIntegrationProfileGrant(
      row?.id ?? request.profile!,
      request.caller.agentGroupId,
      request.operation,
    );
    if (!row || !granted || row.adapter_id !== request.adapterId || row.adapter_version !== request.adapterVersion) {
      throw new HostIntegrationInvocationError('not_authorized', 'authorization');
    }
    return row.id;
  }
  if (!row || row.adapter_id !== request.adapterId || row.adapter_version !== request.adapterVersion) {
    throw new HostIntegrationInvocationError('invalid_configuration', 'authorization');
  }
  return row.id;
}
