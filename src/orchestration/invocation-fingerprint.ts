import fs from 'fs';
import path from 'path';

import type { SessionRuntimePlan } from '../capabilities/session-runtime-plan.js';
import { stableFingerprint } from './fallback-policy.js';

interface ProtocolToolContract {
  capabilityId: string;
  toolName: string;
  schemaFingerprint: string;
}

let cachedContract: Map<string, ProtocolToolContract> | undefined;

function protocolToolContract(projectRoot = process.cwd()): Map<string, ProtocolToolContract> {
  if (cachedContract) return cachedContract;
  const rows = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'contracts', 'protocol-tools.json'), 'utf8'),
  ) as ProtocolToolContract[];
  cachedContract = new Map(rows.map((row) => [row.capabilityId, row]));
  return cachedContract;
}

export function capabilityFingerprint(plan: SessionRuntimePlan): string {
  return stableFingerprint(plan.capabilities.map((capability) => capability.id).sort());
}

export function toolSchemaFingerprint(plan: SessionRuntimePlan, projectRoot = process.cwd()): string {
  const contract = protocolToolContract(projectRoot);
  const schemas = plan.capabilities
    .filter((capability) => capability.adapter === 'protocol-tool')
    .map((capability) => {
      const row = contract.get(capability.id);
      if (!row || capability.entrypoint !== `tool:${row.toolName}` || !/^[a-f0-9]{64}$/.test(row.schemaFingerprint)) {
        throw new Error(`Missing concrete protocol tool schema contract: ${capability.id}`);
      }
      return {
        capabilityId: capability.id,
        toolName: row.toolName,
        schemaFingerprint: row.schemaFingerprint,
      };
    })
    .sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
  return stableFingerprint(schemas);
}
