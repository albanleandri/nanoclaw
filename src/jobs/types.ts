import type { JobEventRecord, JobRecord } from '../db/jobs.js';

export interface JobContext {
  jobId: string;
  agentGroupId: string;
}

export interface JobCommand {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface JobTypeDefinition<TParams = unknown> {
  type: string;
  validateParams(params: unknown): TParams;
  buildCommand(ctx: JobContext, params: TParams): JobCommand;
  formatProgress?(event: JobEventRecord): string | null;
  formatFinal?(job: JobRecord, events: JobEventRecord[]): string;
}

export interface StartJobInput {
  id?: string;
  type: string;
  params: unknown;
  agentGroupId: string;
  sessionId?: string | null;
  messagingGroupId?: string | null;
  channelType?: string | null;
  platformId?: string | null;
  threadId?: string | null;
  requestedBy?: string | null;
}

export type ManagedJobEvent = {
  type: string;
  message?: string;
  level?: 'info' | 'progress' | 'warning' | 'error' | 'final';
  current?: number;
  total?: number;
  data?: unknown;
};
