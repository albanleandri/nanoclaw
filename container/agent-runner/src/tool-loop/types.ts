export interface ProtocolToolDefinition {
  capabilityId: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ProtocolToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface ProtocolToolResult {
  callId: string;
  output: string;
  isError: boolean;
}

export interface ProtocolToolBroker {
  list(): ProtocolToolDefinition[];
  execute(call: ProtocolToolCall): Promise<ProtocolToolResult>;
  resetTurn?(): void;
}

export type ProtocolToolErrorClassification =
  | 'tool_invalid'
  | 'tool_unauthorized'
  | 'tool_execution'
  | 'tool_loop_limit';

export class ProtocolToolError extends Error {
  constructor(
    message: string,
    readonly classification: ProtocolToolErrorClassification,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProtocolToolError';
  }
}
