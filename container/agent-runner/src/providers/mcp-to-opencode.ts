import type { McpServerConfig } from './types.js';

/** OpenCode `mcp` entry shape (local stdio server). */
export type OpenCodeMcpLocal = {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  enabled: true;
};

export type OpenCodeMcpEntry = OpenCodeMcpLocal;

/** Map NanoClaw MCP definitions into OpenCode's local/remote MCP config. */
export function mcpServersToOpenCodeConfig(
  servers: Record<string, McpServerConfig> | undefined,
): Record<string, OpenCodeMcpEntry> {
  const out: Record<string, OpenCodeMcpEntry> = {};
  if (!servers) return out;
  for (const [name, cfg] of Object.entries(servers)) {
    out[name] = {
      type: 'local',
      command: [cfg.command, ...cfg.args],
      ...(Object.keys(cfg.env).length > 0 ? { environment: cfg.env } : {}),
      enabled: true,
    };
  }
  return out;
}
