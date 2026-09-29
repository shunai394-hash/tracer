import "server-only";

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number | string | null;
  result?: { tools?: McpTool[]; content?: unknown; isError?: boolean };
  error?: { code: number; message: string; data?: unknown };
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

function parseEventStream(body: string): JsonRpcResponse {
  const frames = body.split(/\r?\n\r?\n/).map((frame) =>
    frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n")
  ).filter(Boolean);
  const data = frames.at(-1);
  if (!data) throw new McpRequestError("MCP returned an empty event stream");
  try { return JSON.parse(data) as JsonRpcResponse; }
  catch { throw new McpRequestError("MCP returned invalid JSON"); }
}

async function readRpcResponse(response: Response): Promise<JsonRpcResponse> {
  const body = await response.text();
  if (!response.ok) throw new McpRequestError(
    `MCP request failed (${response.status}): ${body.slice(0, 500)}`
  );
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return parseEventStream(body);
  }
  try { return JSON.parse(body) as JsonRpcResponse; }
  catch { throw new McpRequestError("MCP returned an unsupported response"); }
}

export function createMcpToolConsumer(options: {
  endpoint: string;
  accessToken?: string;
  clientName?: string;
  clientVersion?: string;
}) {
  const endpoint = new URL(options.endpoint).toString();
  let requestId = 0;
  let sessionId: string | undefined;
  let initialized = false;

  async function rpc(method: string, params: Record<string, unknown> = {}, notification = false) {
    const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
    if (!notification) body.id = ++requestId;
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;

    const response = await fetch(endpoint, {
      method: "POST", headers, body: JSON.stringify(body), cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    sessionId ??= response.headers.get("Mcp-Session-Id") ?? undefined;
    if (notification && (response.status === 202 || response.status === 204)) return {};
    const payload = await readRpcResponse(response);
    if (payload.error) throw new McpRequestError(
      `MCP ${method} failed: ${payload.error.message}`
    );
    return payload;
  }

  async function ensureInitialized() {
    if (initialized) return;
    await rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION, capabilities: {},
      clientInfo: { name: options.clientName ?? "tracer", version: options.clientVersion ?? "0.1.0" },
    });
    await rpc("notifications/initialized", {}, true);
    initialized = true;
  }

  return {
    endpoint,
    async listTools(): Promise<McpTool[]> {
      await ensureInitialized();
      return (await rpc("tools/list")).result?.tools ?? [];
    },
    async callTool(call: McpToolCall): Promise<unknown> {
      await ensureInitialized();
      const response = await rpc("tools/call", { name: call.name, arguments: call.arguments });
      if (response.result?.isError) throw new McpRequestError(
        `MCP tool "${call.name}" returned an error`
      );
      return response.result?.content ?? null;
    },
  };
}
