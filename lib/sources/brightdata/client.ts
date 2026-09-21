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

function normalizeText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(value: unknown): string | null {
  const text = normalizeText(value);

  if (!text) {
    return null;
  }

  try {
    return new URL(text).toString();
  } catch {
    return null;
  }
}

function normalizePrice(value: unknown): string | null {
  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const text = value.trim();

  if (!text) {
    return null;
  }

  return text;
}

function findFirstString(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function extractShoppingProducts(
  payload: unknown,
): BrightDataProductCandidate[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const root = payload as Record<string, unknown>;

  let shopping: unknown = root.shopping;

  if (!Array.isArray(shopping)) {
    const body = root.body;

    if (typeof body === "string") {
      try {
        const parsedBody = JSON.parse(body) as unknown;

        if (
          parsedBody &&
          typeof parsedBody === "object" &&
          Array.isArray(
            (parsedBody as Record<string, unknown>).shopping,
          )
        ) {
          shopping = (parsedBody as Record<string, unknown>).shopping;
        }
      } catch {
        return [];
      }
    }
  }

  if (!Array.isArray(shopping)) {
    return [];
  }

  const products: BrightDataProductCandidate[] = [];
  const seen = new Set<string>();

  for (const item of shopping) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;

    const title = normalizeText(
      findFirstString(record, [
        "title",
        "name",
        "product_name",
        "productName",
      ]),
    );

    if (!title || seen.has(title)) {
      continue;
    }

    const price = normalizePrice(
      record.price ??
        record.current_price ??
        record.currentPrice ??
        record.price_text ??
        record.priceText,
    );

    const seller = normalizeText(
      findFirstString(record, [
        "seller",
        "merchant",
        "source",
        "store",
        "retailer",
      ]),
    );

    const productUrl = normalizeUrl(
      record.link ??
        record.url ??
        record.product_url ??
        record.productUrl ??
        record.href,
    );

    const imageUrl = normalizeUrl(
      record.image ??
        record.image_url ??
        record.imageUrl ??
        record.thumbnail ??
        record.thumbnail_url ??
        record.thumbnailUrl,
    );

    seen.add(title);

    products.push({
      title,
      price,
      seller: seller || null,
      productUrl,
      imageUrl,
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
    `https://www.google.com/search?q=${encodeURIComponent(
      normalizedQuery,
    )}&tbm=shop&hl=ja&gl=jp&brd_json=1`;

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
          format: "json",
          data_format: "json",
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

  let payload: unknown;

  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new BrightDataRequestError(
      "Bright Data returned invalid JSON",
    );
  }

  let innerPayload = payload;

  if (
    payload &&
    typeof payload === "object" &&
    typeof (payload as Record<string, unknown>).body === "string"
  ) {
    const bodyText = (
      payload as Record<string, unknown>
    ).body as string;

    try {
      innerPayload = JSON.parse(bodyText);
    } catch {
      // Bright Data may return the scraped response as plain text.
      // Keep the original payload so downstream extraction can inspect it.
      innerPayload = payload;
    }
  }

  const products = extractShoppingProducts(innerPayload);

  return {
    query: normalizedQuery,
    products,
  };
}

export async function fetchBrightDataPage(url: string): Promise<{
  url: string;
  html: string | null;
  json: unknown;
}> {
  const client = getBrightDataClient();
  const config = getBrightDataConfig();

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
      }),
      cache: "no-store",
    });
  } catch {
    throw new BrightDataRequestError("Could not connect to Bright Data");
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
  let json: unknown = null;
  try {
    json = JSON.parse(rawBody);
  } catch {
    json = null;
  }

  let html: string | null = null;
  if (typeof rawBody === "string" && rawBody.includes("<")) {
    html = rawBody;
  }
  if (json && typeof json === "object") {
    const record = json as Record<string, unknown>;
    if (typeof record.body === "string") {
      html = record.body;
    }
    if (typeof record.html === "string") {
      html = record.html;
    }
  }

  return { url, html, json };
}
