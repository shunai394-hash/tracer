import "server-only";

import { getBrightDataConfig } from "@/lib/config/env";

/**
 * TRACER consumes external MCP servers (Bright Data MCP and others).
 * It does not host an MCP server in this foundation.
 *
 * Bright Data currently exposes Streamable HTTP at /mcp. Keep the full
 * configured URL (including path/query parameters) rather than reducing it
 * to the origin, because the token and Pro/tool-scope parameters live there.
 */
export type McpToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number | string | null;
  result?: {
    tools?: Array<{ name: string }>;
    content?: unknown;
    isError?: boolean;
  };
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

const PROTOCOL_VERSION = "2025-11-25";

export class McpConfigError extends Error {
  readonly code = "MCP_NOT_CONFIGURED" as const;

  constructor(message = "MCP endpoint is not configured") {
    super(message);
    this.name = "McpConfigError";
  }
}

export class McpRequestError extends Error {
  readonly code = "MCP_REQUEST_FAILED" as const;

  constructor(message: string) {
    super(message);
    this.name = "McpRequestError";
  }
}

export function isMcpConfigured(): boolean {
  return Boolean(getBrightDataConfig().mcpUrl);
}

function parseEventStream(body: string): JsonRpcResponse {
  const frames = body
    .split(/\r?\n\r?\n/)
    .map((frame) =>
      frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter(Boolean);

  const data = frames.at(-1);
  if (!data) {
    throw new McpRequestError("MCP returned an empty event stream");
  }

  try {
    return JSON.parse(data) as JsonRpcResponse;
  } catch {
    throw new McpRequestError("MCP returned invalid JSON");
  }
}

async function readRpcResponse(response: Response): Promise<JsonRpcResponse> {
  const body = await response.text();
  if (!response.ok) {
    throw new McpRequestError(
      `MCP request failed (${response.status}): ${body.slice(0, 500)}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return parseEventStream(body);
  }

  try {
    return JSON.parse(body) as JsonRpcResponse;
  } catch {
    throw new McpRequestError("MCP returned an unsupported response");
  }
}

export function getMcpToolConsumer() {
  const { mcpUrl } = getBrightDataConfig();
  if (!mcpUrl) {
    throw new McpConfigError();
  }

  const url = new URL(mcpUrl).toString();
  let requestId = 0;
  let sessionId: string | undefined;
  let initialized = false;

  async function rpc(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<JsonRpcResponse> {
    const body = {
      jsonrpc: "2.0",
      id: ++requestId,
      method,
      params,
    };

    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };

    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });

    sessionId ??= response.headers.get("Mcp-Session-Id") ?? undefined;

    const payload = await readRpcResponse(response);
    if (payload.error) {
      throw new McpRequestError(
        `MCP ${method} failed: ${payload.error.message}`,
      );
    }

    return payload;
  }

  async function ensureInitialized(): Promise<void> {
    if (initialized) return;

    await rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "tracer",
        version: "0.1.0",
      },
    });

    // MCP requires the client to announce that initialization is complete.
    await rpc("notifications/initialized");
    initialized = true;
  }

  return {
    endpoint: url,
    async listTools(): Promise<string[]> {
      await ensureInitialized();
      const response = await rpc("tools/list");
      return (response.result?.tools ?? []).map((tool) => tool.name);
    },
    async callTool(call: McpToolCall): Promise<unknown> {
      await ensureInitialized();
      const response = await rpc("tools/call", {
        name: call.name,
        arguments: call.arguments,
      });

      if (response.result?.isError) {
        throw new McpRequestError(`MCP tool "${call.name}" returned an error`);
      }

      return response.result?.content ?? null;
    },
  };
}
