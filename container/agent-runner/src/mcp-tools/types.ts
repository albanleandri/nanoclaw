import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface McpToolDefinition {
  tool: Tool;
  audit?: {
    capabilityId: string;
    capabilityVersion: number;
    sensitiveFields?: string[];
  };
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}
