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


function extractHtmlFromMcpPayload(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("<") && /<html|<!doctype|<script|<body|<a\b/i.test(trimmed)) return trimmed;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return extractHtmlFromMcpPayload(parsed, depth + 1);
    } catch {
      // Bright Data MCP commonly returns Markdown rather than raw HTML.
      // Convert only explicit HTTP(S) Markdown links so the existing ranking
      // parser can consume discovered product links; no identity is inferred.
      if (!/\[[^\]]+\]\(https?:\/\//i.test(trimmed)) return null;
      const escapeHtml = (input: string) => input
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      const html = trimmed
        .split(/\r?\n/)
        .map((line) => {
          const linked = line.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)(?:\s+[^)]*)?\)/g,
            (_match, label: string, href: string) => `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`);
          return `<p>${linked}</p>`;
        })
        .join("\n");
      return html.includes("<a href=") ? html : null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractHtmlFromMcpPayload(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["html", "body", "raw_html", "rawHtml", "content", "text", "result"]) {
    const found = extractHtmlFromMcpPayload(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Fetch a page through Bright Data Remote MCP. Tool names and schemas vary by
 * account, so select only a URL-capable scrape tool discovered from tools/list.
 * Never log tool arguments or endpoint values because they may contain secrets.
 */
export async function fetchBrightDataMcpPage(url: string): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) throw new McpRequestError("MCP page URL must be HTTP(S)");
  const consumer = getMcpToolConsumer();
  const tools = await consumer.listTools();
  const candidates = tools
    .filter((tool) => /scrape|fetch.*page|page.*fetch|browser/i.test(`${tool.name} ${tool.description ?? ""}`))
    .map((tool) => {
      const schema = tool.inputSchema && typeof tool.inputSchema === "object"
        ? tool.inputSchema as Record<string, unknown>
        : {};
      const properties = schema.properties && typeof schema.properties === "object"
        ? schema.properties as Record<string, unknown>
        : {};
      const urlKey = ["url", "target_url", "targetUrl", "uri", "link"].find((key) => key in properties);
      const required = Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === "string") : [];
      const supported = Boolean(urlKey) && required.every((key) =>
        key === urlKey || ["format", "output_format", "country", "country_code", "render", "timeout"].includes(key)
      );
      const htmlPreference = /html/i.test(tool.name) ? 0 : /markdown/i.test(tool.name) ? 2 : 1;
      return { tool, properties, required, urlKey, supported, htmlPreference };
    })
    .filter((candidate) => candidate.supported && candidate.urlKey)
    .sort((a, b) => a.htmlPreference - b.htmlPreference);
  const selected = candidates[0];
  if (!selected || !selected.urlKey) return null;

  const args: Record<string, unknown> = { [selected.urlKey]: url };
  for (const key of selected.required) {
    if (key === selected.urlKey) continue;
    if (key === "format" || key === "output_format") args[key] = "html";
    else if (key === "country" || key === "country_code") args[key] = "jp";
    else if (key === "render") args[key] = true;
    else if (key === "timeout") args[key] = 30;
  }
  const payload = await consumer.callTool({ name: selected.tool.name, arguments: args });
  return extractHtmlFromMcpPayload(payload);
}
