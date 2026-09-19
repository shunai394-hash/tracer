import "server-only";

import { getBrightDataConfig } from "@/lib/config/env";

/**
 * TRACER consumes external MCP servers (Bright Data MCP and others).
 * It does not host an MCP server in this foundation.
 */
export type McpToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export class McpConfigError extends Error {
  readonly code = "MCP_NOT_CONFIGURED" as const;

  constructor(message = "MCP endpoint is not configured") {
    super(message);
    this.name = "McpConfigError";
  }
}

export function isMcpConfigured(): boolean {
  return Boolean(getBrightDataConfig().mcpUrl);
}

export function getMcpToolConsumer() {
  const { mcpUrl } = getBrightDataConfig();
  if (!mcpUrl) {
    throw new McpConfigError();
  }

  return {
    endpoint: new URL(mcpUrl).origin,
    async listTools(): Promise<string[]> {
      throw new Error("MCP tool listing is not implemented yet");
    },
    async callTool(call: McpToolCall): Promise<never> {
      void call;
      throw new Error("MCP tool calls are not implemented yet");
    },
  };
}
