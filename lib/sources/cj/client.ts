import "server-only";

import { getCJConfig } from "@/lib/config/env";
import {
  selectUnambiguousVariant,
  verifyVariantSelectionInvariants,
  type CJProductVariant,
} from "@/lib/sources/cj/variant-select";

export { selectUnambiguousVariant, verifyVariantSelectionInvariants };
export type { CJProductVariant };

export class CJConfigError extends Error {
  readonly code = "CJ_NOT_CONFIGURED" as const;

  constructor(message = "CJdropshipping is not configured") {
    super(message);
    this.name = "CJConfigError";
  }
}

export class CJRequestError extends Error {
  readonly code = "CJ_REQUEST_FAILED" as const;

  constructor(message = "CJdropshipping request failed") {
    super(message);
    this.name = "CJRequestError";
  }
}

type CJAuthResponse = {
  code?: number;
  result?: boolean;
  message?: string;
  data?: {
    accessToken?: string;
    refreshToken?: string;
  };
};

type CJProduct = {
  id?: string;
  nameEn?: string;
  sku?: string;
  bigImage?: string;
  sellPrice?: string;
  nowPrice?: string | null;
  warehouseInventoryNum?: number;
  listedNum?: number;
  productType?: string;
  saleStatus?: string;
  barcode?: string;
  productBarCode?: string;
  shippingCost?: string;
};

type CJProductResponse = {
  code?: number;
  result?: boolean;
  message?: string;
  data?: {
    pageSize?: number;
    pageNumber?: number;
    totalRecords?: number;
    totalPages?: number;
    content?: Array<{
      productList?: CJProduct[];
    }>;
  };
};

export type CJProductCandidate = {
  id: string;
  title: string;
  sku: string | null;
  price: string | null;
  imageUrl: string | null;
  inventory: number | null;
  listedNum: number | null;
  productType: string | null;
  saleStatus: string | null;
  barcode: string | null;
  shippingCost: string | null;
};

export type CJSearchResult = {
  query: string;
  totalRecords: number;
  totalPages: number;
  products: CJProductCandidate[];
};

let cachedToken: {
  accessToken: string;
  expiresAt: number;
} | null = null;

let lastCJRequestAt = 0;
let cjRequestChain: Promise<void> = Promise.resolve();

async function waitForCJRateLimit(): Promise<void> {
  let release!: () => void;
  const previous = cjRequestChain;
  cjRequestChain = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  const minIntervalMs = 750;
  const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastCJRequestAt));
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  lastCJRequestAt = Date.now();
  release();
}

async function fetchCJWithRateLimit(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await waitForCJRateLimit();

    const response = await fetch(input, init);
    if (response.status !== 429 || attempt === maxAttempts) {
      return response;
    }

    const retryAfter = Number(response.headers.get("retry-after") ?? "");
    const retryMs =
      Number.isFinite(retryAfter) && retryAfter >= 0
        ? Math.min(Math.max(retryAfter * 1000, 1_000), 15_000)
        : Math.min(1000 * 2 ** (attempt - 1), 8_000);

    console.warn("[cj] rate limited; retrying", {
      attempt,
      maxAttempts,
      retryMs,
    });

    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }

  throw new CJRequestError("CJ request retry loop exhausted");
}

function getConfig() {
  const config = getCJConfig();

  if (!config.apiKey) {
    throw new CJConfigError();
  }

  return config;
}

async function getAccessToken(): Promise<string> {
  const { apiKey } = getConfig();

  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }

  const response = await fetchCJWithRateLimit(
    "https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ apiKey }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new CJRequestError(
      `CJ authentication failed with HTTP ${response.status}`,
    );
  }

  const payload = (await response.json()) as CJAuthResponse;

  const accessToken = payload.data?.accessToken;

  if (!accessToken) {
    throw new CJRequestError(
      payload.message || "CJ access token was not returned",
    );
  }

  cachedToken = {
    accessToken,
    expiresAt: Date.now() + 150_000,
  };

  return accessToken;
}

/**
 * Temporary diagnostic: logs the raw CJ product object's field names and
 * values (server console only, never the API response) so a human can
 * confirm what CJ's live product list/detail payload actually contains —
 * in particular whether `barcode`/`productBarCode` are ever populated at
 * all. Never logs the API key or access token. Off by default; set
 * CJ_DEBUG_LOG=1 to enable while diagnosing. Remove once the real CJ field
 * mapping in normalizeProduct() below has been confirmed against live data.
 */
function logRawCjProductOnce(label: string, product: CJProduct, logged: { done: boolean }) {
  if (process.env.CJ_DEBUG_LOG !== "1" || logged.done) return;
  logged.done = true;
  console.log(`[cj-diagnostic] ${label} raw product keys:`, Object.keys(product));
  console.log(`[cj-diagnostic] ${label} raw product:`, JSON.stringify(product));
}

const searchLogState = { done: false };
const detailLogState = { done: false };

function normalizeProduct(product: CJProduct): CJProductCandidate | null {
  const id = product.id?.trim();
  const title = product.nameEn?.trim();

  if (!id || !title) {
    return null;
  }

  return {
    id,
    title,
    sku: product.sku?.trim() || null,
    price: product.sellPrice?.trim() || product.nowPrice?.trim() || null,
    imageUrl: product.bigImage?.trim() || null,
    inventory:
      typeof product.warehouseInventoryNum === "number"
        ? product.warehouseInventoryNum
        : null,
    listedNum:
      typeof product.listedNum === "number" ? product.listedNum : null,
    productType: product.productType?.trim() || null,
    saleStatus: product.saleStatus?.trim() || null,
    barcode: product.barcode?.trim() || product.productBarCode?.trim() || null,
    shippingCost: product.shippingCost?.trim() || null,
  };
}

export async function searchCJProducts(
  query: string,
  options?: {
    page?: number;
    size?: number;
  },
): Promise<CJSearchResult> {
  const normalizedQuery = query.trim();

  if (!normalizedQuery) {
    throw new CJRequestError("CJ product search query is empty");
  }

  const page = options?.page ?? 1;
  const size = options?.size ?? 20;

  const token = await getAccessToken();

  const params = new URLSearchParams({
    page: String(page),
    size: String(size),
    keyWord: normalizedQuery,
  });

  const response = await fetchCJWithRateLimit(
    `https://developers.cjdropshipping.com/api2.0/v1/product/listV2?${params.toString()}`,
    {
      method: "GET",
      headers: {
        "CJ-Access-Token": token,
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new CJRequestError(
      `CJ product search failed with HTTP ${response.status}`,
    );
  }

  const payload = (await response.json()) as CJProductResponse;

  if (payload.result === false) {
    throw new CJRequestError(
      payload.message || "CJ product search failed",
    );
  }

  const content = payload.data?.content ?? [];

  const rawProducts = content.flatMap(
    (group) => group.productList ?? [],
  );

  if (rawProducts[0]) logRawCjProductOnce("product/listV2", rawProducts[0], searchLogState);

  const products = rawProducts
    .map(normalizeProduct)
    .filter((product): product is CJProductCandidate => product !== null);

  return {
    query: normalizedQuery,
    totalRecords: payload.data?.totalRecords ?? products.length,
    totalPages: payload.data?.totalPages ?? 1,
    products,
  };
}

export async function getCJProductDetail(
  pid: string,
): Promise<CJProductCandidate | null> {
  const token = await getAccessToken();
  const params = new URLSearchParams({ pid });
  const response = await fetchCJWithRateLimit(
    `https://developers.cjdropshipping.com/api2.0/v1/product/query?${params.toString()}`,
    {
      method: "GET",
      headers: { "CJ-Access-Token": token },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new CJRequestError(
      `CJ product query failed with HTTP ${response.status}`,
    );
  }

  const payload = (await response.json()) as {
    result?: boolean;
    data?: CJProduct & { productList?: CJProduct[] };
  };
  const product = payload.data?.id
    ? payload.data
    : payload.data?.productList?.[0];
  if (product) logRawCjProductOnce("product/query", product, detailLogState);
  return product ? normalizeProduct(product) : null;
}

/**
 * UNVERIFIED FIELD MAPPING — read this before trusting this function.
 *
 * developers.cjdropshipping.com and developers.cjdropshipping.cn are both
 * blocked by this environment's network egress proxy (EGRESS_BLOCKED), so
 * the primary "CJ Docs > API v2.0 > product.html" page could not be fetched
 * and read directly. The endpoint path and field names below come from
 * search-engine-indexed secondary sources only (an AI-summarized web search,
 * not a page this code read itself) — they are a best-effort reconstruction,
 * not a confirmed official contract. Field names that could not be
 * corroborated at all (notably any per-variant inventory/stock field) are
 * deliberately left unmapped below and surfaced as null, not guessed.
 *
 * Before CJ_LIVE_ORDERING is ever set to 1 against a real account, a human
 * must open the live CJ developer docs, compare this against the real
 * response shape, and correct anything that differs.
 */
type CJVariantRow = {
  vid?: string;
  variantId?: string;
  pid?: string;
  productId?: string;
  variantSku?: string;
  sku?: string;
  variantNameEn?: string;
  variantKey?: string;
  variantSellPrice?: string | number;
  barcode?: string | number;
};

type CJVariantQueryResponse = {
  code?: number;
  result?: boolean;
  message?: string;
  data?: CJVariantRow[] | {
    content?: CJVariantRow[];
    variantList?: CJVariantRow[];
    productList?: CJVariantRow[];
  };
};

function extractCJVariantRows(data: CJVariantQueryResponse["data"]): CJVariantRow[] {
  if (Array.isArray(data)) return data;
  if (!data) return [];
  return data.content ?? data.variantList ?? data.productList ?? [];
}

export async function fetchCJProductVariants(pid: string): Promise<CJProductVariant[]> {
  const token = await getAccessToken();
  const params = new URLSearchParams({ pid });
  const response = await fetchCJWithRateLimit(
    `https://developers.cjdropshipping.com/api2.0/v1/product/variant/query?${params.toString()}`,
    {
      method: "GET",
      headers: { "CJ-Access-Token": token },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new CJRequestError(
      `CJ variant query failed with HTTP ${response.status}`,
    );
  }

  const payload = (await response.json()) as CJVariantQueryResponse;

  if (payload.result === false) {
    throw new CJRequestError(payload.message || "CJ variant query failed");
  }

  const rows = extractCJVariantRows(payload.data);

  if (process.env.CJ_DEBUG_LOG === "1") {
    console.log("[cj-diagnostic] product/variant/query response:", JSON.stringify(payload));
  }

  return rows
    .map((row): CJProductVariant | null => {
      const vid = row.vid?.trim() || row.variantId?.trim();
      if (!vid) return null;
      return {
        vid,
        productId: row.pid?.trim() || row.productId?.trim() || pid,
        sku: row.variantSku?.trim() || row.sku?.trim() || null,
        nameEn: row.variantNameEn?.trim() || row.variantKey?.trim() || null,
        sellPrice:
          row.variantSellPrice === undefined || row.variantSellPrice === null
            ? null
            : String(row.variantSellPrice),
        barcode:
          row.barcode === undefined || row.barcode === null
            ? null
            : String(row.barcode).replace(/\D/g, "") || null,
        inventory: null,
      };
    })
    .filter((variant): variant is CJProductVariant => variant !== null);
}
