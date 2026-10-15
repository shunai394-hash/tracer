import "server-only";

import { getBrightDataConfig } from "@/lib/config/env";
import {
  createMcpToolConsumer,
  McpConfigError,
  McpRequestError,
  type McpToolCall,
} from "@/lib/sources/mcp/remote-client";

export { McpConfigError, McpRequestError };
export type { McpToolCall };

export function isMcpConfigured(): boolean {
  return Boolean(getBrightDataConfig().mcpUrl);
}

export function getMcpToolConsumer() {
  const { mcpUrl, mcpApiKey } = getBrightDataConfig();
  if (!mcpUrl) throw new McpConfigError();
  return createMcpToolConsumer({
    endpoint: mcpUrl,
    ...(mcpApiKey ? { accessToken: mcpApiKey } : {}),
    clientName: "tracer",
    clientVersion: "0.1.0",
  });
}
