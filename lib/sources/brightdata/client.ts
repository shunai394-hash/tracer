import "server-only";

import { getBrightDataConfig } from "@/lib/config/env";
import { repairMojibakeText } from "@/lib/market/charset";
import { getMcpToolConsumer, isMcpConfigured } from "@/lib/sources/mcp";
import type { McpToolCall } from "@/lib/sources/mcp";

export class BrightDataConfigError extends Error {
  readonly code = "BRIGHTDATA_NOT_CONFIGURED" as const;
  constructor(message = "Bright Data is not configured") { super(message); this.name = "BrightDataConfigError"; }
}

export class BrightDataRequestError extends Error {
  readonly code = "BRIGHTDATA_REQUEST_FAILED" as const;
  constructor(message = "Bright Data request failed") { super(message); this.name = "BrightDataRequestError"; }
}

export type BrightDataProductCandidate = {
  title: string;
  price: string | null;
  seller: string | null;
  productUrl: string | null;
  imageUrl: string | null;
};

export type BrightDataSearchResult = {
  query: string;
  products: BrightDataProductCandidate[];
  provider: "brightdata_mcp" | "brightdata_api";
};

export function isBrightDataConfigured(): boolean {
  const config = getBrightDataConfig();
  return Boolean(config.apiToken && config.zone);
}

export function getBrightDataClient() {
  const config = getBrightDataConfig();
  if (!config.apiToken) throw new BrightDataConfigError("Bright Data API token is not configured");
  if (!config.zone) throw new BrightDataConfigError("Bright Data zone is not configured");
  return { zone: config.zone, isReady: true as const };
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return repairMojibakeText(value)
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\\s+/g, " ").trim();
}

function normalizeUrl(value: unknown): string | null {
  const text = normalizeText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch { return null; }
}

function normalizePrice(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

function findFirstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function unwrapMcpContent(value: unknown): unknown {
  if (!Array.isArray(value)) return parseJsonText(value);
  const parsed: unknown[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") parsed.push(parseJsonText(record.text));
  }
  return parsed.length === 1 ? parsed[0] : parsed;
}

function extractShoppingProducts(payload: unknown): BrightDataProductCandidate[] {
  const unwrapped = unwrapMcpContent(payload);
  if (Array.isArray(unwrapped)) {
    for (const item of unwrapped) {
      const nested = extractShoppingProducts(item);
      if (nested.length) return nested;
    }
    return [];
  }
  if (!unwrapped || typeof unwrapped !== "object") return [];
  const root = unwrapped as Record<string, unknown>;
  let items: unknown = root.shopping ?? root.products ?? root.results ?? root.organic ?? root.items;
  if (!Array.isArray(items) && typeof root.body === "string") {
    const body = parseJsonText(root.body);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const bodyRoot = body as Record<string, unknown>;
      items = bodyRoot.shopping ?? bodyRoot.products ?? bodyRoot.results ?? bodyRoot.organic ?? bodyRoot.items;
    }
  }
  if (!Array.isArray(items)) return [];
  const products: BrightDataProductCandidate[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const title = normalizeText(findFirstString(record, ["title", "name", "product_name", "productName"]));
    if (!title || seen.has(title)) continue;
    const price = normalizePrice(record.price ?? record.current_price ?? record.currentPrice ?? record.price_text ?? record.priceText);
    const seller = normalizeText(findFirstString(record, ["seller", "merchant", "source", "store", "retailer"]));
    const productUrl = normalizeUrl(record.link ?? record.url ?? record.product_url ?? record.productUrl ?? record.href);
    const imageUrl = normalizeUrl(record.image ?? record.image_url ?? record.imageUrl ?? record.thumbnail ?? record.thumbnail_url ?? record.thumbnailUrl);
    seen.add(title);
    products.push({ title, price, seller: seller || null, productUrl, imageUrl });
    if (products.length >= 100) break;
  }
  return products;
}

function mcpArguments(tool: { name: string; inputSchema?: Record<string, unknown> }, query: string, shoppingUrl: string): Record<string, unknown> {
  const schema = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {};
  const properties = schema.properties && typeof schema.properties === "object"
    ? schema.properties as Record<string, unknown> : {};
  const args: Record<string, unknown> = {};
  if ("query" in properties) args.query = query;
  else if ("search_query" in properties) args.search_query = query;
  else if ("url" in properties) args.url = shoppingUrl;
  else if ("urls" in properties) args.urls = [shoppingUrl];
  else throw new BrightDataRequestError(`Bright Data MCP tool ${tool.name} has no supported query/url input`);
  if ("engine" in properties) args.engine = "google";
  if ("country" in properties) args.country = "JP";
  if ("language" in properties) args.language = "ja";
  if ("locale" in properties) args.locale = "ja-JP";
  return args;
}

async function searchViaBrightDataMcp(query: string, shoppingUrl: string): Promise<BrightDataProductCandidate[] | null> {
  if (!isMcpConfigured()) return null;
  try {
    const consumer = getMcpToolConsumer();
    const tools = await consumer.listTools();
    const preferred = ["search_engine", "search_engine_batch", "scrape_as_markdown", "scrape_as_markdown_batch"];
    for (const name of preferred) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) continue;
      const call: McpToolCall = { name: tool.name, arguments: mcpArguments(tool, query, shoppingUrl) };
      const result = await consumer.callTool(call);
      const products = extractShoppingProducts(result);
      if (products.length) return products;
    }
    return null;
  } catch (error) {
    // Do not log the MCP endpoint: it may contain the authentication token.
    console.warn("[BRIGHTDATA MCP] search unavailable; trying API fallback", error instanceof Error ? error.message : "unknown error");
    return null;
  }
}

export async function searchGoogleProducts(query: string): Promise<BrightDataSearchResult> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) throw new BrightDataRequestError("Search query is required");
  const shoppingUrl = `https://www.google.com/search?q=${encodeURIComponent(normalizedQuery)}&tbm=shop&hl=ja&gl=jp&brd_json=1`;

  const mcpProducts = await searchViaBrightDataMcp(normalizedQuery, shoppingUrl);
  if (mcpProducts?.length) {
    return { query: normalizedQuery, products: mcpProducts, provider: "brightdata_mcp" };
  }

  const client = getBrightDataClient();
  const config = getBrightDataConfig();
  let response: Response;
  try {
    response = await fetch("https://api.brightdata.com/request", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiToken}` },
      body: JSON.stringify({ zone: client.zone, url: shoppingUrl, format: "json", data_format: "json" }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new BrightDataRequestError("Could not connect to Bright Data");
  }
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new BrightDataRequestError(`Bright Data returned HTTP ${response.status}${message ? `: ${message.slice(0, 300)}` : ""}`);
  }
  const rawBody = await response.text();
  let payload: unknown;
  try { payload = JSON.parse(rawBody); }
  catch { throw new BrightDataRequestError("Bright Data returned invalid JSON"); }
  let innerPayload = payload;
  if (payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).body === "string") {
    const bodyText = (payload as Record<string, unknown>).body as string;
    try { innerPayload = JSON.parse(bodyText); } catch { innerPayload = payload; }
  }
  return { query: normalizedQuery, products: extractShoppingProducts(innerPayload), provider: "brightdata_api" };
}

export async function fetchBrightDataPage(url: string): Promise<{ url: string; html: string | null; json: unknown }> {
  const client = getBrightDataClient();
  const config = getBrightDataConfig();
  let response: Response;
  try {
    response = await fetch("https://api.brightdata.com/request", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiToken}` },
      body: JSON.stringify({ zone: client.zone, url, format: "raw" }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new BrightDataRequestError("Could not connect to Bright Data"); }
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new BrightDataRequestError(`Bright Data returned HTTP ${response.status}${message ? `: ${message.slice(0, 300)}` : ""}`);
  }
  const rawBody = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(rawBody); } catch { json = null; }
  let html: string | null = typeof rawBody === "string" && rawBody.includes("<") ? rawBody : null;
  if (json && typeof json === "object") {
    const record = json as Record<string, unknown>;
    if (typeof record.body === "string") html = record.body;
    if (typeof record.html === "string") html = record.html;
  }
  if (html) html = repairMojibakeText(html);
  return { url, html, json };
}
