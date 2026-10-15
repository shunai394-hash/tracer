import "server-only";

import { getCJConfig } from "@/lib/config/env";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  selectUnambiguousVariant,
  verifyVariantSelectionInvariants,
  type CJProductVariant,
} from "@/lib/sources/cj/variant-select";
import { firstCJImageUrl, parseCJStockData } from "@/lib/sources/cj/parse";
import { getCJQuotaCooldownUntil, isCJQuotaExhausted } from "@/lib/sources/cj/rate-limit-policy";

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
  readonly code: string;

  constructor(message = "CJdropshipping request failed", code = "CJ_REQUEST_FAILED") {
    super(message);
    this.code = code;
    this.name = "CJRequestError";
  }
}

export function isCJQuotaExhaustedError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "CJ_QUOTA_EXHAUSTED",
  );
}

export function isCJQuotaCircuitBlockingError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    ["CJ_QUOTA_EXHAUSTED", "CJ_QUOTA_CIRCUIT_STATE_UNKNOWN"].includes(
      String((error as { code?: unknown }).code ?? ""),
    ),
  );
}

let localCJQuotaBlockedUntil: string | null = null;

function quotaCircuitIsOpen(blockedUntil: unknown): blockedUntil is string {
  return typeof blockedUntil === "string" && Date.parse(blockedUntil) > Date.now();
}

async function persistCJQuotaCircuit(reason: string): Promise<string> {
  const blockedUntil = getCJQuotaCooldownUntil();
  localCJQuotaBlockedUntil = blockedUntil;
  try {
    const db = createSupabaseAdminClient();
    const now = new Date().toISOString();
    const { error } = await db.from("cron_runs").insert({
      job_name: "cj-api-quota-circuit",
      status: "succeeded",
      started_at: now,
      finished_at: now,
      processed: 0,
      failed: 1,
      metadata: { blockedUntil, reason, source: "cj-client" },
    });
    if (error) throw new CJRequestError("CJ quota circuit persistence failed; refusing further external requests", "CJ_QUOTA_CIRCUIT_STATE_UNKNOWN");
  } catch (error) {
    if (error instanceof CJRequestError) throw error;
    throw new CJRequestError("CJ quota circuit persistence failed; refusing further external requests", "CJ_QUOTA_CIRCUIT_STATE_UNKNOWN");
  }
  return blockedUntil;
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
  // product/listV2 fields
  id?: string;
  nameEn?: string;
  sku?: string;
  bigImage?: string;
  // product/query (detail) uses different field names for the same data
  pid?: string;
  productNameEn?: string;
  productSku?: string;
  productImage?: string | string[];
  sellPrice?: string | number;
  nowPrice?: string | number | null;
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

async function waitForLocalCJRateLimit(): Promise<void> {
  let release!: () => void;
  const previous = cjRequestChain;
  cjRequestChain = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  const minIntervalMs = 1_100;
  const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastCJRequestAt));
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  lastCJRequestAt = Date.now();
  release();
}

export async function waitForCJRateLimit(): Promise<void> {
  // Vercel can run multiple serverless instances concurrently. The old
  // in-memory limiter serialized requests only inside one instance, so two
  // concurrent instances could still violate CJ's global 1 QPS limit.
  // Claim the next slot in Supabase first; fall back to the old local
  // limiter only if the shared limiter is temporarily unavailable.
  let circuitChecked = false;
  try {
    if (quotaCircuitIsOpen(localCJQuotaBlockedUntil)) {
      throw new CJRequestError(`CJ API quota cooldown active until ${localCJQuotaBlockedUntil}`, "CJ_QUOTA_EXHAUSTED");
    }
    const db = createSupabaseAdminClient();
    const { data: circuitRows, error: circuitError } = await db
      .from("cron_runs")
      .select("metadata")
      .eq("job_name", "cj-api-quota-circuit")
      .order("started_at", { ascending: false })
      .limit(1);
    if (circuitError) {
      throw new CJRequestError("CJ quota circuit state unavailable; refusing external request", "CJ_QUOTA_CIRCUIT_STATE_UNKNOWN");
    }
    circuitChecked = true;
    const circuitMetadata = circuitRows?.[0]?.metadata;
    const blockedUntil = circuitMetadata && typeof circuitMetadata === "object" && !Array.isArray(circuitMetadata)
      ? (circuitMetadata as Record<string, unknown>).blockedUntil
      : null;
    if (quotaCircuitIsOpen(blockedUntil)) {
      localCJQuotaBlockedUntil = blockedUntil;
      throw new CJRequestError(`CJ API quota cooldown active until ${blockedUntil}`, "CJ_QUOTA_EXHAUSTED");
    }
    const { data, error } = await db.rpc("claim_cj_api_slot", {
      p_min_interval_ms: 1_100,
    });
    if (!error) {
      const waitMs = Math.max(0, Number(data ?? 0));
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      return;
    }
    console.warn("[cj] shared QPS limiter unavailable; using local fallback", error.message);
  } catch (error) {
    if (
      error instanceof CJRequestError &&
      (error.code === "CJ_QUOTA_EXHAUSTED" || error.code === "CJ_QUOTA_CIRCUIT_STATE_UNKNOWN")
    ) {
      throw error;
    }
    if (!circuitChecked) {
      throw new CJRequestError("CJ quota circuit state unavailable; refusing external request", "CJ_QUOTA_CIRCUIT_STATE_UNKNOWN");
    }
    console.warn(
      "[cj] shared QPS limiter unavailable; using local fallback",
      error instanceof Error ? error.message : String(error),
    );
  }

  await waitForLocalCJRateLimit();
}

export async function fetchCJWithRateLimit(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await waitForCJRateLimit();

    const response = await fetch(input, init);
    if (response.status !== 429) {
      return response;
    }

    const diagnosticResponse = response.clone();
    let diagnostic: { code?: number; result?: boolean; message?: string; pointsInfo?: unknown } = {};
    try {
      diagnostic = (await diagnosticResponse.json()) as typeof diagnostic;
    } catch {
      // Keep the original response available to the caller.
    }

    console.warn("[cj] HTTP 429", {
      attempt,
      maxAttempts,
      code: diagnostic.code,
      message: diagnostic.message,
      pointsInfo: diagnostic.pointsInfo,
    });

    if (isCJQuotaExhausted(diagnostic)) {
      const blockedUntil = await persistCJQuotaCircuit("provider_points_remaining_zero");
      throw new CJRequestError(
        `${diagnostic.message || "CJ API quota exhausted"}; cooldown until ${blockedUntil}`,
        "CJ_QUOTA_EXHAUSTED",
      );
    }

    if (attempt === maxAttempts) {
      return response;
    }

    const retryAfter = Number(response.headers.get("retry-after") ?? "");
    const retryMs =
      Number.isFinite(retryAfter) && retryAfter >= 0
        ? Math.min(Math.max(retryAfter * 1000, 1_000), 15_000)
        : Math.min(1000 * 2 ** (attempt - 1), 8_000);

    console.warn("[cj] QPS rate limited; retrying", {
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
  const id = product.id?.trim() || product.pid?.trim();
  const title = product.nameEn?.trim() || product.productNameEn?.trim();

  if (!id || !title) {
    return null;
  }

  return {
    id,
    title,
    sku: product.sku?.trim() || product.productSku?.trim() || null,
    price: String(product.sellPrice ?? "").trim() || String(product.nowPrice ?? "").trim() || null,
    imageUrl: product.bigImage?.trim() || firstCJImageUrl(product.productImage),
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

export async function fetchCJVariantByVid(vid: string): Promise<CJProductVariant | null> {
  const normalizedVid = vid.trim();
  if (!normalizedVid) throw new CJRequestError("CJ variant id is empty");

  const token = await getAccessToken();
  const params = new URLSearchParams({ vid: normalizedVid, features: "enable_inventory" });
  const response = await fetchCJWithRateLimit(
    `https://developers.cjdropshipping.com/api2.0/v1/product/variant/queryByVid?${params.toString()}`,
    {
      method: "GET",
      headers: { "CJ-Access-Token": token },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new CJRequestError(
      `CJ variant detail lookup failed with HTTP ${response.status}`,
    );
  }

  const payload = (await response.json()) as CJVariantQueryResponse;
  if (payload.result === false) {
    throw new CJRequestError(payload.message || "CJ variant detail lookup failed");
  }

  const row = extractCJVariantRows(payload.data)[0];
  if (!row) return null;

  const id = row.vid?.trim() || row.variantId?.trim();
  if (!id) return null;

  const verifiedByCountry = new Map<string, { quantity: number; storageId: string | null }>();
  for (const inventoryRow of row.inventories ?? []) {
    const countryCode = String(inventoryRow.countryCode ?? "").trim().toUpperCase();
    const quantity = Number(inventoryRow.cjInventory);
    if (
      !/^[A-Z]{2}$/.test(countryCode) ||
      Number(inventoryRow.verifiedWarehouse) !== 1 ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) continue;
    const current = verifiedByCountry.get(countryCode);
    const storageId = inventoryRow.storageId === undefined || inventoryRow.storageId === null
      ? null
      : String(inventoryRow.storageId);
    verifiedByCountry.set(countryCode, {
      quantity: (current?.quantity ?? 0) + Math.floor(quantity),
      storageId: current?.storageId === storageId ? storageId : null,
    });
  }
  const inventoryByCountry = [...verifiedByCountry.entries()]
    .map(([countryCode, value]) => ({ countryCode, quantity: value.quantity, storageId: value.storageId }))
    .sort((a, b) => b.quantity - a.quantity);
  const verifiedInventory = inventoryByCountry.reduce((sum, row) => sum + row.quantity, 0);

  return {
    vid: id,
    productId: row.pid?.trim() || row.productId?.trim() || "",
    sku: row.variantSku?.trim() || row.sku?.trim() || null,
    nameEn: row.variantNameEn?.trim() || row.variantKey?.trim() || null,
    sellPrice:
      row.variantSellPrice === undefined || row.variantSellPrice === null
        ? null
        : String(row.variantSellPrice),
    barcode:
      [row.barcode, row.variantBarcode, row.variantBarCode, row.productBarCode]
        .find((value) => value !== undefined && value !== null && String(value).trim())
        ? String(
            [row.barcode, row.variantBarcode, row.variantBarCode, row.productBarCode]
              .find((value) => value !== undefined && value !== null && String(value).trim()),
          ).replace(/\D/g, "") || null
        : null,
    inventory: inventoryByCountry.length ? verifiedInventory : null,
    inventoryByCountry,
  };
}

export async function fetchCJProductInventory(
  productId: string,
): Promise<number | null> {
  const normalizedProductId = productId.trim();
  if (!normalizedProductId) {
    throw new CJRequestError("CJ product id is empty");
  }

  try {
    const token = await getAccessToken();
    const params = new URLSearchParams({ pid: normalizedProductId });
    const response = await fetchCJWithRateLimit(
      `https://developers.cjdropshipping.com/api2.0/v1/product/stock/getInventoryByPid?${params.toString()}`,
      {
        method: "GET",
        headers: { "CJ-Access-Token": token },
        cache: "no-store",
      },
    );
    if (response.ok) {
      const payload = (await response.json()) as { result?: boolean; data?: unknown };
      if (payload.result !== false) {
        const data = payload.data as Record<string, unknown> | null | undefined;
        // Product-level warehouse totals, not the per-variant breakdown.
        const quantity = parseCJStockData(
          data && typeof data === "object" && Array.isArray(data.inventories)
            ? data.inventories
            : data,
        );
        if (quantity !== null) return quantity;
      }
    }
  } catch (error) {
    if (error instanceof CJConfigError) throw error;
    // Fall through to the catalog listing below.
  }

  const result = await searchCJProducts(normalizedProductId, { page: 1, size: 20 });
  const exact = result.products.find((product) => product.id === normalizedProductId);
  return exact?.inventory ?? null;
}

export async function fetchCJVariantStock(vid: string): Promise<number | null> {
  const normalizedVid = vid.trim();
  if (!normalizedVid) throw new CJRequestError("CJ variant id is empty");

  const token = await getAccessToken();
  const params = new URLSearchParams({ vid: normalizedVid });
  const response = await fetchCJWithRateLimit(
    `https://developers.cjdropshipping.com/api2.0/v1/product/stock/queryByVid?${params.toString()}`,
    {
      method: "GET",
      headers: { "CJ-Access-Token": token },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new CJRequestError(
      `CJ variant stock lookup failed with HTTP ${response.status}`,
    );
  }

  const payload = (await response.json()) as {
    result?: boolean;
    message?: string;
    data?: unknown;
  };

  if (payload.result === false) {
    throw new CJRequestError(payload.message || "CJ variant stock lookup failed");
  }

  return parseCJStockData(payload.data);
}

export type CJFreightOption = {
  logisticName: string;
  shippingCost: number;
  arrivalTime: string | null;
};

export async function getCJFreightOptions(
  vid: string,
  options?: {
    startCountryCode?: string;
    endCountryCode?: string;
    zip?: string;
    quantity?: number;
  },
): Promise<CJFreightOption[]> {
  const token = await getAccessToken();
  const response = await fetchCJWithRateLimit(
    "https://developers.cjdropshipping.com/api2.0/v1/logistic/freightCalculate",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CJ-Access-Token": token,
      },
      body: JSON.stringify({
        startCountryCode: options?.startCountryCode ?? "CN",
        endCountryCode: options?.endCountryCode ?? "JP",
        ...(options?.zip ? { zip: options.zip } : {}),
        products: [
          {
            quantity: options?.quantity ?? 1,
            vid,
          },
        ],
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new CJRequestError(
      `CJ freight options lookup failed with HTTP ${response.status}`,
    );
  }

  const payload = (await response.json()) as {
    result?: boolean;
    message?: string;
    data?: Array<{
      logisticName?: string;
      logisticPrice?: number | string | null;
      totalPostageFee?: number | string | null;
      logisticAging?: string | null;
    }>;
  };

  if (payload.result === false) {
    throw new CJRequestError(payload.message || "CJ freight options lookup failed");
  }

  return (payload.data ?? [])
    .map((row) => {
      const name = typeof row.logisticName === "string" ? row.logisticName.trim() : "";
      const total = Number(row.totalPostageFee);
      const simple = Number(row.logisticPrice);
      const shippingCost =
        Number.isFinite(total) && total > 0
          ? total
          : Number.isFinite(simple) && simple > 0
            ? simple
            : null;
      if (!name || shippingCost === null) return null;
      return {
        logisticName: name,
        shippingCost,
        arrivalTime:
          typeof row.logisticAging === "string" && row.logisticAging.trim()
            ? row.logisticAging.trim()
            : null,
      };
    })
    .filter((row): row is CJFreightOption => row !== null)
    .sort((a, b) => a.shippingCost - b.shippingCost);
}

export async function calculateCJFreight(
  vid: string,
  options?: {
    startCountryCode?: string;
    endCountryCode?: string;
    quantity?: number;
    zip?: string;
  },
): Promise<number | null> {
  const token = await getAccessToken();
  const response = await fetchCJWithRateLimit(
    "https://developers.cjdropshipping.com/api2.0/v1/logistic/freightCalculate",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CJ-Access-Token": token,
      },
      body: JSON.stringify({
        startCountryCode: options?.startCountryCode ?? "CN",
        endCountryCode: options?.endCountryCode ?? "JP",
        ...(options?.zip ? { zip: options.zip } : {}),
        products: [
          {
            quantity: options?.quantity ?? 1,
            vid,
          },
        ],
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new CJRequestError(
      `CJ freight calculation failed with HTTP ${response.status}`,
    );
  }

  const payload = (await response.json()) as {
    result?: boolean;
    message?: string;
    data?: unknown;
  };

  if (payload.result === false) {
    throw new CJRequestError(payload.message || "CJ freight calculation failed");
  }

  // CJ has returned several freight field names across API versions and
  // wrappers. Accept the documented price fields plus equivalent numeric
  // postage/shipping fields, while never treating an unknown value as zero.
  const readPrice = (value: unknown): number | null => {
    if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    return null;
  };

  const rows: unknown[] = Array.isArray(payload.data)
    ? payload.data
    : payload.data && typeof payload.data === "object"
      ? Object.values(payload.data as Record<string, unknown>).flatMap((value) =>
          Array.isArray(value) ? value : [value],
        )
      : [];

  const prices = rows
    .map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      const record = row as Record<string, unknown>;
      for (const key of [
        "totalPostageFee",
        "logisticPrice",
        "shippingCost",
        "shippingFee",
        "postageFee",
        "freight",
        "freightCost",
      ]) {
        const price = readPrice(record[key]);
        if (price !== null) return price;
      }
      return null;
    })
    .filter((value): value is number => value !== null);

  return prices.length > 0 ? Math.min(...prices) : null;
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
    data?: unknown;
  };

  // product/query has appeared as either a single object or a wrapper
  // containing productList/content in different CJ API responses. Normalize
  // both forms instead of turning a valid product into null.
  const data = payload.data;
  let product: CJProduct | undefined;
  if (Array.isArray(data)) {
    product = data[0] as CJProduct | undefined;
  } else if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (record.id || record.pid) {
      product = record as CJProduct;
    } else if (Array.isArray(record.productList)) {
      product = record.productList[0] as CJProduct | undefined;
    } else if (Array.isArray(record.content)) {
      product = record.content[0] as CJProduct | undefined;
    }
  }

  if (product) logRawCjProductOnce("product/query", product, detailLogState);
  return product ? normalizeProduct(product) : null;
}

/**
 * CJ variant detail mapping follows the official API v2.0 variant query
 * contract. Inventory is requested explicitly with features=enable_inventory.
 * Only cjInventory from verified warehouses (verifiedWarehouse=1) is usable
 * for live order preflight; factory inventory and unverified warehouses are
 * deliberately excluded. The first production response must still be checked
 * against these documented fields before enabling live ordering.
 */
type CJVariantInventoryRow = {
  countryCode?: string;
  cjInventory?: number | string;
  totalInventory?: number | string;
  verifiedWarehouse?: number | string | boolean;
  storageId?: string | number;
};

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
  variantBarcode?: string | number;
  variantBarCode?: string | number;
  productBarCode?: string | number;
  inventories?: CJVariantInventoryRow[];
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

function toCJProductVariant(row: CJVariantRow, pid: string): CJProductVariant | null {
  const vid = row.vid?.trim() || row.variantId?.trim();
  if (!vid) return null;
  const barcode = [row.barcode, row.variantBarcode, row.variantBarCode, row.productBarCode]
    .find((value) => value !== undefined && value !== null && String(value).trim());
  return {
    vid,
    productId: row.pid?.trim() || row.productId?.trim() || pid,
    sku: row.variantSku?.trim() || row.sku?.trim() || null,
    nameEn: row.variantNameEn?.trim() || row.variantKey?.trim() || null,
    sellPrice:
      row.variantSellPrice === undefined || row.variantSellPrice === null
        ? null
        : String(row.variantSellPrice),
    barcode: barcode ? String(barcode).replace(/\D/g, "") || null : null,
    inventory: null,
  };
}

async function queryCJVariantRows(pid: string, countryCode?: string): Promise<CJVariantRow[]> {
  const token = await getAccessToken();
  const params = new URLSearchParams({ pid });
  if (countryCode) params.set("countryCode", countryCode);
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

  if (process.env.CJ_DEBUG_LOG === "1") {
    console.log("[cj-diagnostic] product/variant/query response:", JSON.stringify(payload));
  }

  return extractCJVariantRows(payload.data);
}

/** product/query embeds the full variant list under data.variants. */
async function queryCJDetailVariantRows(pid: string): Promise<CJVariantRow[]> {
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
  if (!response.ok) return [];
  const payload = (await response.json()) as { result?: boolean; data?: unknown };
  if (payload.result === false) return [];
  const data = Array.isArray(payload.data) ? payload.data[0] : payload.data;
  if (!data || typeof data !== "object") return [];
  const variants = (data as Record<string, unknown>).variants;
  return Array.isArray(variants) ? (variants as CJVariantRow[]) : [];
}

export async function fetchCJProductVariants(
  pid: string,
  options?: { countryCode?: string },
): Promise<CJProductVariant[]> {
  // countryCode restricts CJ's answer to variants stocked in that country's
  // warehouse; for CN-shipped items to Japan that is usually an empty list,
  // which made every catalog candidate look variant-less. Fall back to the
  // unfiltered list and then to the variants embedded in product/query.
  let rows = await queryCJVariantRows(pid, options?.countryCode);
  if (rows.length === 0 && options?.countryCode) rows = await queryCJVariantRows(pid);
  if (rows.length === 0) rows = await queryCJDetailVariantRows(pid);

  return rows
    .map((row) => toCJProductVariant(row, pid))
    .filter((variant): variant is CJProductVariant => variant !== null);
}
