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
  brand: string | null;
  price: string | null;
  currency: string | null;
  seller: string | null;
  productUrl: string | null;
  imageUrl: string | null;
  /** Verified identifiers supplied by the source; never infer these from title text. */
  asin?: string | null;
  jan?: string | null;
  gtin?: string | null;
  ean?: string | null;
  upc?: string | null;
  mpn?: string | null;
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

export function isBrightDataFetchConfigured(): boolean {
  return isBrightDataConfigured() || isMcpConfigured();
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
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\s+/g, " ").trim();
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
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return normalizePrice(record.amount ?? record.value ?? record.price ?? record.text ?? record.formatted);
  }
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

const SUPPORTED_CURRENCIES = new Set(["JPY", "USD", "EUR", "GBP", "CNY", "CAD", "AUD", "KRW", "TWD", "HKD", "SGD", "INR"]);

function normalizeCurrency(explicitValue: unknown, rawPrice: unknown): string | null {
  const explicit = normalizeText(
    typeof explicitValue === "string" ? explicitValue :
    explicitValue && typeof explicitValue === "object" && !Array.isArray(explicitValue)
      ? String((explicitValue as Record<string, unknown>).code ?? (explicitValue as Record<string, unknown>).currency ?? "")
      : "",
  ).toUpperCase();
  if (/^[A-Z]{3}$/.test(explicit) && SUPPORTED_CURRENCIES.has(explicit)) return explicit;
  const priceText = typeof rawPrice === "string"
    ? rawPrice
    : rawPrice && typeof rawPrice === "object" && !Array.isArray(rawPrice)
      ? String((rawPrice as Record<string, unknown>).text ?? (rawPrice as Record<string, unknown>).formatted ?? "")
      : "";
  const codeMatch = priceText.match(/\b(JPY|USD|EUR|GBP|CNY|CAD|AUD|KRW|TWD|HKD|SGD|INR)\b/i);
  if (codeMatch && SUPPORTED_CURRENCIES.has(codeMatch[1].toUpperCase())) return codeMatch[1].toUpperCase();
  if (/[¥￥]/.test(priceText)) return "JPY";
  if (/€/.test(priceText)) return "EUR";
  if (/£/.test(priceText)) return "GBP";
  // "$" is ambiguous across USD/CAD/AUD and is never enough to claim USD.
  return null;
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
  const envelope = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
  const mcpPayload = envelope?.structuredContent ?? envelope?.content ?? payload;
  const unwrapped = unwrapMcpContent(mcpPayload);
  if (Array.isArray(unwrapped)) {
    const productRecords = unwrapped.filter((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const record = item as Record<string, unknown>;
      const hasTitle = Boolean(findFirstString(record, ["title", "name", "product_name", "productName", "product_title", "productTitle"]));
      const hasUrl = Boolean(findFirstString(record, ["link", "url", "product_url", "productUrl", "product_link", "productLink", "source_url", "sourceUrl", "href"]));
      return hasTitle && hasUrl;
    });
    if (productRecords.length) return extractShoppingProducts({ products: productRecords });
    for (const item of unwrapped) {
      const nested = extractShoppingProducts(item);
      if (nested.length) return nested;
    }
    return [];
  }
  if (typeof unwrapped === "string") {
    // Production MCP can return HTML via scrape_as_html; parse explicit
    // Product JSON-LD instead of treating arbitrary ranking links as products.
    if (/<(?:!doctype|html|script|body|div)\b/i.test(unwrapped)) {
      const structured: unknown[] = [];
      const scripts = unwrapped.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
      for (const match of scripts) {
        const parsed = parseJsonText(match[1]);
        if (parsed && typeof parsed === "object") structured.push(parsed);
      }
      const collectProducts = (node: unknown, depth = 0): unknown[] => {
        if (depth > 8 || node == null) return [];
        if (Array.isArray(node)) return node.flatMap((item) => collectProducts(item, depth + 1));
        if (typeof node !== "object") return [];
        const record = node as Record<string, unknown>;
        const type = record["@type"];
        const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
        if (isProduct) {
          const offersValue = record.offers;
          const offers = Array.isArray(offersValue) ? offersValue[0] : offersValue;
          const offer = offers && typeof offers === "object" ? offers as Record<string, unknown> : {};
          return [{
            title: record.name,
            brand: typeof record.brand === "string" ? record.brand :
              record.brand && typeof record.brand === "object" ? (record.brand as Record<string, unknown>).name : null,
            price: offer.price ?? offer.lowPrice ?? null,
            currency: offer.priceCurrency ?? null,
            url: record.url ?? offer.url ?? null,
            image: Array.isArray(record.image) ? record.image[0] : record.image ?? null,
            seller: offer.seller && typeof offer.seller === "object"
              ? (offer.seller as Record<string, unknown>).name : null,
            asin: record.asin ?? record.ASIN ?? null,
            jan: record.jan ?? record.JAN ?? null,
            gtin: record.gtin ?? record.gtin8 ?? record.gtin12 ?? record.gtin13 ?? record.gtin14 ?? record.GTIN ?? null,
            ean: record.ean ?? record.EAN ?? null,
            upc: record.upc ?? record.UPC ?? null,
            mpn: record.mpn ?? record.model ?? record.model_number ?? null,
          }];
        }
        return Object.values(record).flatMap((value) => collectProducts(value, depth + 1));
      };
      const products = structured.flatMap((item) => collectProducts(item));
      if (products.length) return extractShoppingProducts({ products });
      // Also inspect embedded shopping JSON when a scraper wraps it in HTML.
      const jsonScripts = unwrapped.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi);
      for (const match of jsonScripts) {
        const script = match[1].trim();
        if (!/shopping_results|product_results|products|priceCurrency/.test(script)) continue;
        const parsed = parseJsonText(script);
        const nested = extractShoppingProducts(parsed);
        if (nested.length) return nested;
      }
      // Google Shopping cards often expose title, outbound URL, and price as
      // adjacent HTML nodes rather than JSON-LD. Accept only anchors with an
      // external product URL and an explicit price in the nearby card markup.
      const htmlAnchors = [...unwrapped.matchAll(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)];
      const htmlProducts: BrightDataProductCandidate[] = [];
      const htmlSeen = new Set<string>();
      for (const anchor of htmlAnchors) {
        const hrefText = normalizeText(anchor[2]).replace(/&amp;/gi, "&");
        let productUrl: string | null = null;
        try {
          const href = new URL(hrefText, "https://www.google.com");
          if (/(^|\.)google\.(com|co\.jp)$/i.test(href.hostname) && href.pathname === "/url") {
            productUrl = normalizeUrl(href.searchParams.get("q") ?? href.searchParams.get("url"));
          } else if (!/(^|\.)google\.(com|co\.jp)$/i.test(href.hostname)) {
            productUrl = normalizeUrl(href.toString());
          }
        } catch { productUrl = normalizeUrl(hrefText); }
        if (!productUrl) continue;
        const title = normalizeText(anchor[3]
          .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
          .replace(/<[^>]+>/g, " "));
        if (title.length < 4 || title.length > 200 || htmlSeen.has(title)) continue;
        const offset = anchor.index ?? 0;
        const context = unwrapped.slice(Math.max(0, offset - 700), Math.min(unwrapped.length, offset + anchor[0].length + 1700))
          .replace(/<[^>]+>/g, " ");
        const priceMatch = context.match(/(?:¥|￥|JPY\s*)[\s\u00a0]*[\d,]+(?:\.\d{1,2})?|[\d,]+(?:\.\d{1,2})?\s*円|(?:US\$|USD\s*)[\s\u00a0]*[\d,]+(?:\.\d{1,2})?/i);
        if (!priceMatch) continue;
        const price = normalizeText(priceMatch[0]);
        htmlSeen.add(title);
        htmlProducts.push({
          title,
          brand: null,
          price,
          currency: normalizeCurrency(null, price),
          seller: null,
          productUrl,
          imageUrl: null,
        });
        if (htmlProducts.length >= 100) break;
      }
      if (htmlProducts.length) return htmlProducts;
      return [];
    }
    const lines = unwrapped.split(/\r?\n/);
    const products: BrightDataProductCandidate[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/\[([^\]]{3,200})\]\((https?:\/\/[^)\s]+)\)/);
      if (!match) continue;
      const title = normalizeText(match[1]);
      const productUrl = normalizeUrl(match[2]);
      if (!title || !productUrl || seen.has(title)) continue;
      const context = lines.slice(index, index + 4).join(" ");
      const priceMatch = context.match(/(?:¥|￥|JPY|US\$|\$)\s*[\d,]+(?:\.\d{1,2})?/i);
      if (!priceMatch) continue;
      const sellerMatch = context.match(/(?:from|by|販売元|ショップ)\s+([^|•]{2,80})/i);
      seen.add(title);
      const price = priceMatch?.[0]?.replace(/\s+/g, " ").trim() ?? null;
      products.push({
        title,
        brand: null,
        price,
        currency: normalizeCurrency(null, price),
        seller: sellerMatch ? normalizeText(sellerMatch[1]) : null,
        productUrl,
        imageUrl: null,
      });
      if (products.length >= 100) break;
    }
    return products;
  }
  if (!unwrapped || typeof unwrapped !== "object") return [];
  const root = unwrapped as Record<string, unknown>;
  let items: unknown = root.shopping ?? root.shopping_results ?? root.product_results ?? root.productResults ?? root.products ?? root.results ?? root.organic ?? root.organic_results ?? root.search_results ?? root.searchResults ?? root.items;
  if (!Array.isArray(items) && typeof root.body === "string") {
    const body = parseJsonText(root.body);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const bodyRoot = body as Record<string, unknown>;
      items = bodyRoot.shopping ?? bodyRoot.shopping_results ?? bodyRoot.product_results ?? bodyRoot.productResults ?? bodyRoot.products ?? bodyRoot.results ?? bodyRoot.organic ?? bodyRoot.organic_results ?? bodyRoot.search_results ?? bodyRoot.searchResults ?? bodyRoot.items;
    }
  }
  if (!Array.isArray(items)) {
    // MCP may wrap a valid shopping payload in a response envelope.
    for (const key of ["data", "content", "result", "response", "payload", "body"]) {
      if (root[key] === undefined) continue;
      const nested = extractShoppingProducts(root[key]);
      if (nested.length) return nested;
    }
    return [];
  }
  const products: BrightDataProductCandidate[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const title = normalizeText(findFirstString(record, ["title", "name", "product_name", "productName"]));
    if (!title || seen.has(title)) continue;
    const rawPrice = record.price ?? record.current_price ?? record.currentPrice ?? record.price_text ?? record.priceText;
    const price = normalizePrice(rawPrice);
    const currency = normalizeCurrency(
      record.currency ?? record.currency_code ?? record.currencyCode ?? record.price_currency ?? record.priceCurrency ??
        (rawPrice && typeof rawPrice === "object" && !Array.isArray(rawPrice)
          ? (rawPrice as Record<string, unknown>).currency ?? (rawPrice as Record<string, unknown>).currency_code
          : null),
      rawPrice,
    );
    const brand = normalizeText(findFirstString(record, ["brand", "brand_name", "brandName", "manufacturer"]));
    const seller = normalizeText(findFirstString(record, ["seller", "merchant", "source", "store", "retailer"]));
    const productUrl = normalizeUrl(record.link ?? record.url ?? record.product_url ?? record.productUrl ?? record.href);
    const imageUrl = normalizeUrl(record.image ?? record.image_url ?? record.imageUrl ?? record.thumbnail ?? record.thumbnail_url ?? record.thumbnailUrl);
    seen.add(title);
    products.push({
      title, brand: brand || null, price, currency, seller: seller || null, productUrl, imageUrl,
      asin: findFirstString(record, ["asin", "ASIN", "amazon_asin"]),
      jan: findFirstString(record, ["jan", "JAN", "jan_code", "janCode"]),
      gtin: findFirstString(record, ["gtin", "GTIN", "gtin8", "gtin12", "gtin13", "gtin14"]),
      ean: findFirstString(record, ["ean", "EAN", "ean_code", "eanCode"]),
      upc: findFirstString(record, ["upc", "UPC", "upc_code", "upcCode"]),
      mpn: findFirstString(record, ["mpn", "MPN", "model_number", "modelNumber", "manufacturer_part_number"]),
    });
    if (products.length >= 100) break;
  }
  return products;
}

function mcpArguments(tool: { name: string; inputSchema?: Record<string, unknown> }, query: string, shoppingUrl: string): Record<string, unknown> {
  const schema = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {};
  const properties = schema.properties && typeof schema.properties === "object"
    ? schema.properties as Record<string, unknown> : {};
  const args: Record<string, unknown> = {};
  if ((tool.name === "search_engine" || tool.name === "search_engine_batch") && "query" in properties) args.query = query;
  else if ((tool.name === "search_engine" || tool.name === "search_engine_batch") && "search_query" in properties) args.search_query = query;
  else if ("url" in properties) args.url = shoppingUrl;
  else if ("urls" in properties) args.urls = [shoppingUrl];
  else if ("query" in properties) args.query = query;
  else if ("search_query" in properties) args.search_query = query;
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
    const preferred = ["scrape_as_markdown", "scrape_as_html", "search_engine", "search_engine_batch"];
    for (const name of preferred) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) continue;
      try {
        const call: McpToolCall = { name: tool.name, arguments: mcpArguments(tool, query, shoppingUrl) };
        const result = await consumer.callTool(call);
        const products = extractShoppingProducts(result);
        if (products.length) {
          console.info("[BRIGHTDATA MCP] product search succeeded", { tool: tool.name, count: products.length });
          return products;
        }
      } catch (error) {
        // A tool can be unavailable for a particular account or reject its
        // schema. Continue to the next supported MCP tool before API fallback.
        console.warn("[BRIGHTDATA MCP] tool unavailable", tool.name, error instanceof Error ? error.message : "unknown error");
      }
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

  const mcpConfigured = isMcpConfigured();
  const mcpProducts = await searchViaBrightDataMcp(normalizedQuery, shoppingUrl);
  if (mcpProducts?.length) {
    return { query: normalizedQuery, products: mcpProducts, provider: "brightdata_mcp" };
  }
  // MCP-only production configuration must never fall through to the unrelated
  // Bright Data API token/zone path. Return a precise provider error instead.
  if (mcpConfigured) {
    throw new BrightDataRequestError("Bright Data MCP was configured but returned no parseable shopping products");
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

function extractMcpHtml(value: unknown, depth = 0): string | null {
  if (depth > 5 || value == null) return null;
  const envelope = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const mcpPayload = envelope?.structuredContent ?? envelope?.content ?? value;
  const unwrapped = unwrapMcpContent(mcpPayload);
  if (typeof unwrapped === "string") {
    const text = unwrapped.trim();
    return text.includes("<") && /<html|<!doctype|<script|<div|<body/i.test(text) ? text : null;
  }
  if (Array.isArray(unwrapped)) {
    for (const item of unwrapped) {
      const html = extractMcpHtml(item, depth + 1);
      if (html) return html;
    }
    return null;
  }
  if (typeof unwrapped === "object") {
    const record = unwrapped as Record<string, unknown>;
    for (const key of ["html", "body", "content", "data", "result"]) {
      if (record[key] !== undefined) {
        const html = extractMcpHtml(record[key], depth + 1);
        if (html) return html;
      }
    }
  }
  return null;
}

async function fetchBrightDataPageViaMcp(url: string): Promise<{ html: string | null; json: unknown } | null> {
  if (!isMcpConfigured()) return null;
  try {
    const consumer = getMcpToolConsumer();
    const tools = await consumer.listTools();
    const tool = tools.find((candidate) => candidate.name === "scrape_as_html");
    if (!tool) return null;
    const result = await consumer.callTool({
      name: tool.name,
      arguments: mcpArguments(tool, url, url),
    });
    const html = extractMcpHtml(result);
    const host = new URL(url).hostname;
    if (html) console.info("[BRIGHTDATA MCP] scrape_as_html succeeded", { host, bytes: html.length });
    else console.warn("[BRIGHTDATA MCP] scrape_as_html returned no HTML", { host });
    return { html: html ? repairMojibakeText(html) : null, json: result };
  } catch (error) {
    console.warn("[BRIGHTDATA MCP] HTML fetch unavailable", error instanceof Error ? error.message : "unknown error");
    return null;
  }
}

export async function fetchBrightDataPage(url: string): Promise<{ url: string; html: string | null; json: unknown }> {
  const mcpPage = await fetchBrightDataPageViaMcp(url);
  if (mcpPage?.html) return { url, ...mcpPage };
  if (!isBrightDataConfigured()) {
    throw new BrightDataConfigError("Bright Data MCP raw HTML tool is unavailable and API token/zone are not configured");
  }
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
