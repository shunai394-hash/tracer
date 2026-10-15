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

const DEFAULT_BRIGHTDATA_MCP_ENDPOINT = "https://mcp.brightdata.com/mcp";

function getConfiguredEndpoint(): string | null {
  const { mcpUrl, mcpApiKey } = getBrightDataConfig();
  if (!mcpUrl && !mcpApiKey) return null;

  // Bright Data Remote MCP authenticates with ?token=... on its hosted URL.
  // If a custom endpoint is configured, preserve its options and only add the
  // token when it is not already present. Never log this URL because it carries
  // a secret query parameter.
  const endpoint = new URL(mcpUrl || DEFAULT_BRIGHTDATA_MCP_ENDPOINT);
  if (mcpApiKey && !endpoint.searchParams.has("token")) {
    endpoint.searchParams.set("token", mcpApiKey);
  }
  return endpoint.toString();
}

export function isMcpConfigured(): boolean {
  return getConfiguredEndpoint() !== null;
}

export function getMcpToolConsumer() {
  const endpoint = getConfiguredEndpoint();
  if (!endpoint) throw new McpConfigError();
  return createMcpToolConsumer({
    endpoint,
    clientName: "tracer",
    clientVersion: "0.1.0",
  });
}
