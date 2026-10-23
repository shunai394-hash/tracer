import "server-only";

import { getCJConfig } from "@/lib/config/env";
import { isCanonicalCJNativeId } from "@/lib/sources/cj/native-id.mjs";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  selectUnambiguousVariant,
  verifyVariantSelectionInvariants,
  type CJProductVariant,
} from "@/lib/sources/cj/variant-select";
import { firstCJImageUrl, parseCJStockData } from "@/lib/sources/cj/parse";
import { getCJQuotaCooldownUntil, isCJQuotaCircuitActive, isCJQuotaExhausted } from "@/lib/sources/cj/rate-limit-policy";
import { readCJFreightPrice } from "@/lib/sources/cj/freight-cost";

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

  const minIntervalMs = 2_000;
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
    if (isCJQuotaCircuitActive(circuitMetadata)) {
      if (typeof blockedUntil === "string") localCJQuotaBlockedUntil = blockedUntil;
      throw new CJRequestError(`CJ API quota cooldown active until ${String(blockedUntil)}`, "CJ_QUOTA_EXHAUSTED");
    }
    const { data, error } = await db.rpc("claim_cj_api_slot", {
      p_min_interval_ms: 2_000,
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

    // Bound every supplier request so a stalled CJ endpoint cannot hold the
    // four-minute discovery budget open indefinitely. Preserve caller cancellation.
    const timeoutSignal = AbortSignal.timeout(20_000);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await fetch(input, { ...init, signal });
    } catch (error) {
      // Retry transient network failures and this helper's own 20s timeout.
      // Never retry a caller-requested cancellation, and keep each retry behind
      // the shared CJ QPS limiter to avoid amplifying supplier traffic.
      if (init?.signal?.aborted || attempt === maxAttempts) throw error;
      const retryMs = Math.min(1_000 * 2 ** (attempt - 1), 8_000);
      console.warn("[cj] transient request failure; retrying", {
        attempt,
        maxAttempts,
        retryMs,
        reason: error instanceof Error ? error.name : "unknown",
      });
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      continue;
    }
    // CJ can report daily-point exhaustion in a non-429 JSON response (often
    // HTTP 200 with result=false). Inspect a clone before returning the response
    // so the global circuit opens for every explicit points-exhaustion signal.
    const diagnosticResponse = response.clone();
    let diagnostic: { code?: number; result?: boolean; message?: string; pointsInfo?: unknown } = {};
    try {
      diagnostic = (await diagnosticResponse.json()) as typeof diagnostic;
    } catch {
      // Keep the original response available to the caller.
    }

    if (isCJQuotaExhausted(diagnostic)) {
      const blockedUntil = await persistCJQuotaCircuit("provider_explicit_daily_points_exhausted");
      console.warn("[cj] daily API points exhausted; circuit opened", {
        code: diagnostic.code,
        blockedUntil,
      });
      throw new CJRequestError(
        `${diagnostic.message || "CJ API quota exhausted"}; cooldown until ${blockedUntil}`,
        "CJ_QUOTA_EXHAUSTED",
      );
    }

    if (response.status !== 429) {
      return response;
    }

    console.warn("[cj] HTTP 429", {
      attempt,
      maxAttempts,
      code: diagnostic.code,
      message: diagnostic.message,
      pointsInfo: diagnostic.pointsInfo,
    });

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

  if (!id || !isCanonicalCJNativeId(id) || !title) {
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
  if (!isCanonicalCJNativeId(normalizedVid)) {
    throw new CJRequestError("CJ variant id is not a canonical native ID", "CJ_NATIVE_ID_INVALID");
  }

  const token = await getAccessToken();
  const params = new URLSearchParams({ vid: vid.trim(), features: "enable_inventory" });
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

  const rows = extractCJVariantRows(payload.data);
  // The queryByVid contract is exact-VID lookup. If CJ wraps multiple rows in
  // a collection, never trust the first row: select only the requested VID.
  const row = rows.find((item) => (item.vid?.trim() || item.variantId?.trim()) === normalizedVid);
  if (!row) return null;

  const id = row.vid?.trim() || row.variantId?.trim();
  if (id !== normalizedVid) return null;
  const parentProductId = row.pid?.trim() || row.productId?.trim() || "";
  if (!isCanonicalCJNativeId(parentProductId)) {
    throw new CJRequestError("CJ variant parent ID is not a canonical native ID", "CJ_NATIVE_ID_INVALID");
  }

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
    productId: parentProductId,
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
    imageUrl: row.variantImage?.trim() || null,
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

const CJ_FREIGHT_PRICE_KEYS = [
  "totalPostageFee", "logisticPrice", "shippingCost", "shippingFee",
  "postageFee", "freight", "freightCost", "totalFreight", "freightAmount", "price",
] as const;

/** Find named freight quote rows regardless of CJ's object/array wrapper shape. */
function collectCJFreightRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectCJFreightRows(item));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (CJ_FREIGHT_PRICE_KEYS.some((key) => readCJFreightPrice(record[key]) !== null)) {
    return [record];
  }
  return Object.values(record).flatMap((nested) => collectCJFreightRows(nested));
}

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
    data?: unknown;
  };

  if (payload.result === false) {
    throw new CJRequestError(payload.message || "CJ freight options lookup failed");
  }

  const rows = collectCJFreightRows(payload.data);
  return rows
    .map((record) => {
      const name = typeof record.logisticName === "string" ? record.logisticName.trim() : "";
      const shippingCost = CJ_FREIGHT_PRICE_KEYS
        .map((key) => readCJFreightPrice(record[key]))
        .find((price) => price !== null) ?? null;
      if (!name || shippingCost === null) return null;
      return {
        logisticName: name,
        shippingCost,
        arrivalTime:
          typeof record.logisticAging === "string" && record.logisticAging.trim()
            ? record.logisticAging.trim()
            : null,
      };
    })
    .filter((row): row is CJFreightOption => row !== null)
    .sort((a, b) => a.shippingCost - b.shippingCost);
}

async function calculateCJFreightTipFromProductDetail(
  vid: string,
  options: { startCountryCode: string; endCountryCode: string; quantity: number; zip?: string; productId?: string; diagnostics?: string[] },
): Promise<number | null> {
  const diagnostic = (value: string) => options.diagnostics?.push(value);
  // CJ's detailed freight endpoint requires the exact variant's weight and the
  // product's logistics property. The simple endpoint can return Success + []
  // when these fields are omitted, without explaining which field is missing.
  const parentProductId = options.productId || (await fetchCJVariantByVid(vid))?.productId;
  if (!parentProductId) { diagnostic("product_id_missing"); return null; }
  const token = await getAccessToken();
  const params = new URLSearchParams({ pid: parentProductId });
  const detailResponse = await fetchCJWithRateLimit(
    `https://developers.cjdropshipping.com/api2.0/v1/product/query?${params.toString()}`,
    { method: "GET", headers: { "CJ-Access-Token": token }, cache: "no-store" },
  );
  if (!detailResponse.ok) { diagnostic("product_detail_http_" + detailResponse.status); return null; }
  const detailPayload = await detailResponse.json() as { result?: boolean; data?: unknown };
  if (detailPayload.result === false || !detailPayload.data || typeof detailPayload.data !== "object") { diagnostic("product_detail_empty_or_rejected"); return null; }
  const product = (Array.isArray(detailPayload.data) ? detailPayload.data[0] : detailPayload.data) as Record<string, unknown> | null;
  if (!product) { diagnostic("product_detail_no_product"); return null; }
  const variants = Array.isArray(product.variants) ? product.variants as Array<Record<string, unknown>> : [];
  const variant = variants.find((row) => String(row.vid ?? "") === vid);
  if (!variant) { diagnostic("variant_not_in_product_detail"); return null; }
  const numberFrom = (...values: unknown[]): number | null => {
    for (const value of values) {
      const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  };
  const weight = numberFrom(variant.variantWeight, product.productWeight);
  const wrapWeight = numberFrom(product.packingWeight, variant.variantWeight, product.productWeight);
  const productProps = Array.isArray(product.productProEnSet)
    ? product.productProEnSet.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : typeof product.productProEn === "string"
      ? product.productProEn.split(/[;,]/).map((value) => value.trim()).filter(Boolean)
      : [];
  const sku = typeof variant.variantSku === "string" ? variant.variantSku.trim() : "";
  const unitPrice = numberFrom(variant.variantSellPrice, product.sellPrice);
  const volumeMm3 = numberFrom(variant.variantVolume);
  const lengthMm = numberFrom(variant.variantLength);
  const widthMm = numberFrom(variant.variantWidth);
  const heightMm = numberFrom(variant.variantHeight);
  const volumeCm3 = volumeMm3 ? volumeMm3 / 1000 : lengthMm && widthMm && heightMm ? (lengthMm * widthMm * heightMm) / 1000 : null;
  if (!weight || !wrapWeight || productProps.length === 0 || !volumeCm3 || !sku) {
    console.warn("[CJ FREIGHT TIP INPUT INCOMPLETE]", {
      vid, productId: String(product.pid ?? ""),
      hasWeight: Boolean(weight), hasWrapWeight: Boolean(wrapWeight),
      hasProductProp: productProps.length > 0, hasVolume: Boolean(volumeCm3), hasSku: Boolean(sku),
    });
    diagnostic("tip_input_incomplete:" + [!weight ? "weight" : "", !wrapWeight ? "wrap_weight" : "", productProps.length === 0 ? "product_property" : "", !volumeCm3 ? "volume" : "", !sku ? "sku" : ""].filter(Boolean).join(","));
    return null;
  }
  const body = {
    reqDTOS: [{
      srcAreaCode: options.startCountryCode,
      destAreaCode: options.endCountryCode,
      ...(options.zip ? { zip: options.zip } : {}),
      weight: Math.ceil(weight),
      wrapWeight: Math.ceil(wrapWeight),
      volume: volumeCm3,
      ...(unitPrice ? { totalGoodsAmount: unitPrice * options.quantity } : {}),
      productProp: productProps,
      skuList: sku ? [sku] : [],
      freightTrialSkuList: [{
        vid, ...(sku ? { sku } : {}),
        skuQuantity: options.quantity,
        skuWeight: weight,
        skuVolume: volumeCm3,
      }],
    }],
  };
  const response = await fetchCJWithRateLimit(
    "https://developers.cjdropshipping.com/api2.0/v1/logistic/freightCalculateTip",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "CJ-Access-Token": token },
      body: JSON.stringify(body),
      cache: "no-store",
    },
  );
  if (!response.ok) { diagnostic("tip_http_" + response.status); return null; }
  const payload = await response.json() as { result?: boolean; message?: string; data?: unknown };
  if (payload.result === false) {
    const message = String(payload.message ?? "").slice(0, 80).replace(/[^a-zA-Z0-9 _-]/g, "");
    diagnostic("tip_rejected:" + (message || "unspecified"));
    console.warn("[CJ FREIGHT TIP REJECTED]", { vid, message: String(payload.message ?? "").slice(0, 120) });
    return null;
  }
  const rows: unknown[] = Array.isArray(payload.data)
    ? payload.data
    : payload.data && typeof payload.data === "object"
      ? Object.values(payload.data as Record<string, unknown>).flatMap((value) => Array.isArray(value) ? value : [value])
      : [];
  const prices = rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const record = row as Record<string, unknown>;
    // postage is documented in USD. Do not silently convert or interpret CNY fields.
    for (const key of ["totalPostageFee", "wrapPostage", "postage", "logisticPrice", "shippingCost", "freightAmount"]) {
      const price = readCJFreightPrice(record[key]);
      if (price !== null) return price;
    }
    return null;
  }).filter((value): value is number => value !== null);
  if (prices.length === 0) {
    // One-shot, explicitly allowlisted diagnosis only. This endpoint is expensive
    // and returns reasons, not prices, so it must never run in the normal quote path.
    const diagnosticVid = process.env.CJ_FREIGHT_DIAGNOSTIC_VID?.trim();
    if (diagnosticVid && diagnosticVid === vid) {
      const jobName = ("cj-freight-diagnostic:" + vid).slice(0, 180);
      try {
        const db = createSupabaseAdminClient();
        const { data: priorRuns, error: priorError } = await db
          .from("cron_runs")
          .select("id")
          .eq("job_name", jobName)
          .limit(1);
        if (priorError) throw priorError;
        if (!priorRuns?.length) {
          const now = new Date().toISOString();
          const { error: reserveError } = await db.from("cron_runs").insert({
            job_name: jobName,
            status: "running",
            started_at: now,
            processed: 0,
            failed: 0,
            metadata: { vid, diagnostic: "unavailableShippingMethods", oneShot: true },
          });
          if (reserveError) throw reserveError;
          try {
            const diagnosticResponse = await fetchCJWithRateLimit(
              "https://developers.cjdropshipping.com/api2.0/v1/logistic/unavailableShippingMethods",
              {
                method: "POST",
                headers: { "Content-Type": "application/json", "CJ-Access-Token": token },
                body: JSON.stringify(body),
                cache: "no-store",
              },
            );
            const diagnosticPayload = await diagnosticResponse.json() as {
              code?: number; result?: boolean; message?: string; requestId?: string;
              data?: { availableList?: Array<{ optionName?: string }>; unavailableList?: Array<{ optionName?: string; errorCode?: number; errorEn?: string }> };
            };
            const available = Array.isArray(diagnosticPayload.data?.availableList)
              ? diagnosticPayload.data.availableList.slice(0, 30).map((row) => ({
                  optionName: String(row.optionName ?? "").slice(0, 100),
                }))
              : [];
            const unavailable = Array.isArray(diagnosticPayload.data?.unavailableList)
              ? diagnosticPayload.data.unavailableList.slice(0, 60).map((row) => ({
                  optionName: String(row.optionName ?? "").slice(0, 100),
                  errorCode: typeof row.errorCode === "number" ? row.errorCode : null,
                  errorEn: String(row.errorEn ?? "").slice(0, 240),
                }))
              : [];
            console.warn("[CJ FREIGHT UNAVAILABLE METHODS DIAGNOSTIC]", {
              vid,
              httpStatus: diagnosticResponse.status,
              code: diagnosticPayload.code ?? null,
              result: diagnosticPayload.result ?? null,
              message: String(diagnosticPayload.message ?? "").slice(0, 180),
              requestId: String(diagnosticPayload.requestId ?? "").slice(0, 48),
              availableCount: Array.isArray(diagnosticPayload.data?.availableList) ? diagnosticPayload.data!.availableList!.length : 0,
              unavailableCount: Array.isArray(diagnosticPayload.data?.unavailableList) ? diagnosticPayload.data!.unavailableList!.length : 0,
              available,
              unavailable,
            });
            await db.from("cron_runs").update({
              status: diagnosticResponse.ok && diagnosticPayload.result !== false ? "succeeded" : "failed",
              finished_at: new Date().toISOString(),
              processed: available.length + unavailable.length,
              failed: diagnosticResponse.ok && diagnosticPayload.result !== false ? 0 : 1,
              metadata: {
                vid, diagnostic: "unavailableShippingMethods", oneShot: true,
                httpStatus: diagnosticResponse.status,
                code: diagnosticPayload.code ?? null,
                result: diagnosticPayload.result ?? null,
                requestId: String(diagnosticPayload.requestId ?? "").slice(0, 48),
                availableCount: Array.isArray(diagnosticPayload.data?.availableList) ? diagnosticPayload.data!.availableList!.length : 0,
                unavailableCount: Array.isArray(diagnosticPayload.data?.unavailableList) ? diagnosticPayload.data!.unavailableList!.length : 0,
              },
            }).eq("job_name", jobName);
          } catch (diagnosticError) {
            await db.from("cron_runs").update({
              status: "failed", finished_at: new Date().toISOString(), processed: 0, failed: 1,
              metadata: { vid, diagnostic: "unavailableShippingMethods", oneShot: true, error: diagnosticError instanceof Error ? diagnosticError.message.slice(0, 180) : "unknown_error" },
            }).eq("job_name", jobName);
            console.warn("[CJ FREIGHT UNAVAILABLE METHODS DIAGNOSTIC FAILED]", {
              vid, error: diagnosticError instanceof Error ? diagnosticError.message.slice(0, 180) : "unknown_error",
            });
          }
        }
      } catch (diagnosticGuardError) {
        // Fail closed: do not call the costly diagnostic API if one-shot state
        // cannot be checked and reserved durably.
        console.warn("[CJ FREIGHT UNAVAILABLE METHODS DIAGNOSTIC SKIPPED]", {
          vid, reason: diagnosticGuardError instanceof Error ? diagnosticGuardError.message.slice(0, 160) : "guard_failed",
        });
      }
    }
    console.warn("[CJ FREIGHT TIP NO OPTIONS]", {
      vid, srcAreaCode: options.startCountryCode, destAreaCode: options.endCountryCode,
      result: payload.result ?? null, dataType: Array.isArray(payload.data) ? "array" : typeof payload.data,
      rowCount: rows.length,
    });
    diagnostic("tip_no_options:rows=" + rows.length);
    return null;
  }
  diagnostic("tip_quote_returned");
  return Math.min(...prices);
}

export async function calculateCJFreight(
  vid: string,
  options?: {
    startCountryCode?: string;
    endCountryCode?: string;
    quantity?: number;
    zip?: string;
    productId?: string;
    diagnostics?: string[];
  },
): Promise<number | null> {
  const diagnostic = (value: string) => options?.diagnostics?.push(value);
  const tipQuote = await calculateCJFreightTipFromProductDetail(vid, {
    startCountryCode: options?.startCountryCode ?? "CN",
    endCountryCode: options?.endCountryCode ?? "JP",
    quantity: options?.quantity ?? 1,
    ...(options?.zip ? { zip: options.zip } : {}),
    ...(options?.productId ? { productId: options.productId } : {}),
    ...(options?.diagnostics ? { diagnostics: options.diagnostics } : {}),
  });
  if (tipQuote !== null) return tipQuote;

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
    diagnostic("freight_http_" + response.status);
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
    diagnostic("freight_rejected");
    throw new CJRequestError(payload.message || "CJ freight calculation failed");
  }

  // CJ has returned several freight field names across API versions and
  // wrappers. Accept the documented price fields plus equivalent numeric
  // postage/shipping fields, while never treating an unknown value as zero.
  const rows = collectCJFreightRows(payload.data);
  const prices = rows
    .map((record) => CJ_FREIGHT_PRICE_KEYS
      .map((key) => readCJFreightPrice(record[key]))
      .find((price) => price !== null) ?? null)
    .filter((value): value is number => value !== null);

  if (prices.length === 0) {
    const data = payload.data;
    const rowsForDiagnostics: unknown[] = Array.isArray(data)
      ? data
      : data && typeof data === "object"
        ? Object.values(data as Record<string, unknown>).flatMap((value) =>
            Array.isArray(value) ? value : [value],
          )
        : [];
    const firstRow = rowsForDiagnostics.find(
      (row): row is Record<string, unknown> =>
        Boolean(row) && typeof row === "object" && !Array.isArray(row),
    );
    // Never log the full CJ response or credentials. Key names and response shape
    // are enough to identify API schema changes without exposing product payloads.
    diagnostic("freight_no_quote:rows=" + rowsForDiagnostics.length);
    console.warn("[CJ FREIGHT QUOTE UNRESOLVED]", {
      vid,
      startCountryCode: options?.startCountryCode ?? "CN",
      endCountryCode: options?.endCountryCode ?? "JP",
      quantity: options?.quantity ?? 1,
      zipProvided: Boolean(options?.zip),
      result: payload.result ?? null,
      message: typeof payload.message === "string" ? payload.message.slice(0, 120) : null,
      dataType: Array.isArray(data) ? "array" : data === null ? "null" : typeof data,
      dataKeys: data && typeof data === "object" && !Array.isArray(data)
        ? Object.keys(data as Record<string, unknown>).slice(0, 20)
        : [],
      rowKeys: firstRow ? Object.keys(firstRow).slice(0, 30) : [],
      rows: rowsForDiagnostics.length,
    });
    return null;
  }
  diagnostic("freight_quote_returned");
  return Math.min(...prices);
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
  variantImage?: string;
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
  data?: CJVariantRow[] | CJVariantRow | {
    content?: CJVariantRow[];
    variantList?: CJVariantRow[];
    productList?: CJVariantRow[];
  };
};

function extractCJVariantRows(data: CJVariantQueryResponse["data"]): CJVariantRow[] {
  if (Array.isArray(data)) return data;
  if (!data) return [];
  // queryByVid may return one variant object rather than a collection.
  // Preserve that exact VID and parent product ID for identity resolution.
  if ("vid" in data || "variantId" in data) return [data as CJVariantRow];
  const container = data as {
    content?: CJVariantRow[];
    variantList?: CJVariantRow[];
    productList?: CJVariantRow[];
  };
  return container.content ?? container.variantList ?? container.productList ?? [];
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
