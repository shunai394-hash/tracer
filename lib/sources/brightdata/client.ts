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
    throw new BrightDataConfigError("Bright Data API token is not configured");
  }

  if (!config.zone) {
    throw new BrightDataConfigError("Bright Data zone is not configured");
  }

  return {
    zone: config.zone,
    isReady: true as const,
  };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractProducts(html: string): BrightDataProductCandidate[] {
  const products: BrightDataProductCandidate[] = [];
  const seen = new Set<string>();

  const productPattern =
    /title="([^"]+)"[^>]*aria-hidden="true"[^>]*style="[^"]*"[^>]*data-hveid[\s\S]{0,5000}?aria-label="Current price:\s*([^"]+)"[\s\S]{0,3000}?<span class="WJMUdc rw5ecc">([^<]+)<\/span>/g;

  for (const match of html.matchAll(productPattern)) {
    const title = decodeHtml(match[1]).trim();
    const price = decodeHtml(match[2]).trim();
    const seller = decodeHtml(match[3]).trim();

    if (!title || seen.has(title)) {
      continue;
    }

    seen.add(title);

    products.push({
      title,
      price: price || null,
      seller: seller || null,
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
    throw new BrightDataRequestError("Search query is required");
  }

  const url = `https://www.google.com/search?q=${encodeURIComponent(normalizedQuery)}`;

  let response: Response;

  try {
    response = await fetch("https://api.brightdata.com/request", {
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
    });
  } catch {
    throw new BrightDataRequestError("Could not connect to Bright Data");
  }

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new BrightDataRequestError(
      `Bright Data returned HTTP ${response.status}${message ? `: ${message.slice(0, 300)}` : ""}`,
    );
  }

  const html = await response.text();
  const products = extractProducts(html);

  return {
    query: normalizedQuery,
    products,
  };
}
