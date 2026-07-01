import type { ExecutionPlan, PatternId } from './types.js';

export interface PatternCompileInput {
  taskId: string;
  objective: string;
  kind: string;
  agentGroupId: string;
  sessionId: string;
  createdAt?: string;
}

export interface PatternDefinition {
  id: PatternId;
  version: number;
  description: string;
  compile(input: PatternCompileInput): ExecutionPlan;
}

const patterns = new Map<string, PatternDefinition>();

function key(id: PatternId, version: number): string {
  return `${id}@${version}`;
}

export function registerPattern(definition: PatternDefinition): void {
  const id = key(definition.id, definition.version);
  if (patterns.has(id)) throw new Error(`Orchestration pattern already registered: ${id}`);
  patterns.set(id, definition);
}

export function requirePattern(id: PatternId, version: number): PatternDefinition {
  const definition = patterns.get(key(id, version));
  if (!definition) throw new Error(`Unsupported orchestration pattern: ${id}@${version}`);
  return definition;
}

export function listPatterns(): PatternDefinition[] {
  return [...patterns.values()].sort((a, b) => key(a.id, a.version).localeCompare(key(b.id, b.version)));
}
