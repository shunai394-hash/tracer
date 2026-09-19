import "server-only";

import { getBrightDataConfig } from "@/lib/config/env";

export class BrightDataConfigError extends Error {
  readonly code = "BRIGHTDATA_NOT_CONFIGURED" as const;

  constructor(message = "Bright Data is not configured") {
    super(message);
    this.name = "BrightDataConfigError";
  }
}

export class BrightDataRequestError extends Error {
  readonly code = "BRIGHTDATA_REQUEST_FAILED" as const;

  constructor(message = "Bright Data request failed") {
    super(message);
    this.name = "BrightDataRequestError";
  }
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
};

export function isBrightDataConfigured(): boolean {
  const config = getBrightDataConfig();

  return Boolean(config.apiToken && config.zone);
}

export function getBrightDataClient() {
  const config = getBrightDataConfig();

  if (!config.apiToken) {
    throw new BrightDataConfigError(
      "Bright Data API token is not configured",
    );
  }

  if (!config.zone) {
    throw new BrightDataConfigError(
      "Bright Data zone is not configured",
    );
  }

  return {
    zone: config.zone,
    isReady: true as const,
  };
}

function decodeHtml(value: string): string {
  const rupee = String.fromCharCode(0x20b9);

  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#8377;/gi, rupee)
    .replace(/&#x20b9;/gi, rupee);
}

function normalizeText(value: string): string {
  return decodeHtml(value)
    .replace(/\u00c2/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPrice(value: string): string {
  const rupee = String.fromCharCode(0x20b9);

  return normalizeText(value)
    .replace(/\u00e2\u0082\u00b9/gi, rupee)
    .replace(/\u00e2\u00b9/gi, rupee)
    .replace(/^Current Price:\s*/i, "")
    .replace(/\.\s*Was.*$/i, ".")
    .trim();
}

function extractProducts(html: string): BrightDataProductCandidate[] {
  const products: BrightDataProductCandidate[] = [];
  const seen = new Set<string>();

  const titlePattern =
    /<div[^>]*\bgkQHve\b[^>]*>([\s\S]*?)<\/div>/gi;

  const matches = [...html.matchAll(titlePattern)];

  console.log("[TRACER DEBUG] HTML length:", html.length);
  console.log("[TRACER DEBUG] title matches:", matches.length);

  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];

    const title = normalizeText(
      (match[1] ?? "").replace(/<[^>]+>/g, " "),
    );

    if (!title || seen.has(title)) {
      continue;
    }

    const titleStart = match.index ?? 0;

    const nextTitleStart =
      index + 1 < matches.length
        ? matches[index + 1].index ?? html.length
        : html.length;

    const contextStart = Math.max(0, titleStart - 1500);
    const contextEnd = Math.min(
      html.length,
      nextTitleStart + 1500,
    );

    const context = html.slice(contextStart, contextEnd);

    const priceMatch = context.match(
      /aria-label="[^"]*Current [Pp]rice:\s*([^"]+?)(?:\.\s*(?:And more prices|Was)|")/i,
    );

    const sellerMatch = context.match(
      /<span[^>]*class="[^"]*\bWJMUdc\b[^"]*"[^>]*>([^<]+)<\/span>/i,
    );

    const price = priceMatch
      ? cleanPrice(priceMatch[1].trim())
      : null;

    const seller = sellerMatch
      ? normalizeText(sellerMatch[1])
      : null;

    seen.add(title);

    products.push({
      title,
      price,
      seller,
      productUrl: null,
      imageUrl: null,
    });

    if (products.length >= 100) {
      break;
    }
  }

  return products;
}

export async function searchGoogleProducts(
  query: string,
): Promise<BrightDataSearchResult> {
  const client = getBrightDataClient();
  const config = getBrightDataConfig();

  const normalizedQuery = query.trim();

  if (!normalizedQuery) {
    throw new BrightDataRequestError(
      "Search query is required",
    );
  }

  const url =
    `https://www.google.com/search?q=${encodeURIComponent(normalizedQuery)}`;

  let response: Response;

  try {
    response = await fetch(
      "https://api.brightdata.com/request",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiToken}`,
        },
        body: JSON.stringify({
          zone: client.zone,
          url,
          format: "raw",
          data_format: "html",
        }),
        cache: "no-store",
      },
    );
  } catch {
    throw new BrightDataRequestError(
      "Could not connect to Bright Data",
    );
  }

  if (!response.ok) {
    const message = await response.text().catch(() => "");

    throw new BrightDataRequestError(
      `Bright Data returned HTTP ${response.status}${
        message ? `: ${message.slice(0, 300)}` : ""
      }`,
    );
  }

  const rawBody = await response.text();

  let html = rawBody;

  try {
    const parsed = JSON.parse(rawBody);

    if (typeof parsed === "string") {
      html = parsed;
    } else if (
      parsed &&
      typeof parsed === "object"
    ) {
      const record = parsed as Record<string, unknown>;

      if (typeof record.body === "string") {
        html = record.body;
      } else if (typeof record.content === "string") {
        html = record.content;
      } else if (typeof record.data === "string") {
        html = record.data;
      }
    }
  } catch {
    // Bright Data may return raw HTML directly.
  }

  html = html
    .replace(/\\u003c/gi, "<")
    .replace(/\\u003e/gi, ">")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u0022/gi, '"')
    .replace(/\\u0027/gi, "'")
    .replace(/\\"/g, '"')
    .trim();
  const products = extractProducts(html);

  return {
    query: normalizedQuery,
    products,
  };
}