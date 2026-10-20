import "server-only";
import {
  appendSnapshotRows,
  prepareSnapshotResume,
  type BaseSnapshotCheckpoint,
} from "@/lib/channels/base-snapshot-checkpoint";

export type { BaseSnapshotCheckpoint };

type BaseItemInput = {
  title: string;
  identifier?: string;
  detail: string;
  price: number;
  stock?: number;
  visible?: boolean;
};

type BaseItemResponse = {
  item?: {
    item_id?: string | number;
  };
  item_id?: string | number;
  [key: string]: unknown;
};

const BASE_API_URL = process.env.BASE_API_URL?.trim() || "https://api.thebase.in/1";
const BASE_CLIENT_ID = process.env.BASE_CLIENT_ID?.trim() || "";
const BASE_CLIENT_SECRET = process.env.BASE_CLIENT_SECRET?.trim() || "";
const BASE_REFRESH_TOKEN = process.env.BASE_REFRESH_TOKEN?.trim() || "";

const BASE_REDIRECT_URI = process.env.BASE_REDIRECT_URI?.trim() || "";

let cachedBaseAccessToken: { token: string; expiresAt: number } | null = null;

function baseOAuthConfigReady(): boolean {
  return Boolean(BASE_CLIENT_ID && BASE_CLIENT_SECRET && BASE_REFRESH_TOKEN && BASE_REDIRECT_URI);
}

function safeBaseError(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "unknown_error";
  const record = payload as Record<string, unknown>;
  const value = [record.error_description, record.error, record.message]
    .find((item) => typeof item === "string");
  return typeof value === "string"
    ? value.replace(/(?:access|refresh)_token[=: ]+[^\s,;]+/gi, "[REDACTED]")
        .replace(/client_secret[=: ]+[^\s,;]+/gi, "[REDACTED]")
        .slice(0, 180)
    : "unknown_error";
}

export function isBaseConfigured() {
  // A standalone access token is not accepted as proof of a working BASE
  // integration. Only the complete OAuth refresh configuration is supported.
  return baseOAuthConfigReady();
}

export async function getBasePublicShopUrl(): Promise<string | null> {
  const token = await getBaseAccessToken();
  const response = await fetch(`${BASE_API_URL}/users/me`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let payload: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(`BASE_SHOP_URL_LOOKUP_FAILED:HTTP_${response.status}:${safeBaseError(payload)}`);
  }
  const userRecord = payload?.user && typeof payload.user === "object"
    ? payload.user as Record<string, unknown>
    : payload;
  const value = userRecord?.shop_url;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

async function getBaseAccessToken(): Promise<string> {
  if (cachedBaseAccessToken && Date.now() < cachedBaseAccessToken.expiresAt - 30_000) {
    return cachedBaseAccessToken.token;
  }
  if (!baseOAuthConfigReady()) {
    throw new Error("BASE_OAUTH_CONFIG_INCOMPLETE: configure BASE_CLIENT_ID, BASE_CLIENT_SECRET, BASE_REFRESH_TOKEN, and BASE_REDIRECT_URI");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: BASE_CLIENT_ID,
    client_secret: BASE_CLIENT_SECRET,
    refresh_token: BASE_REFRESH_TOKEN,
    redirect_uri: BASE_REDIRECT_URI,
  });

  const response = await fetch(`${BASE_API_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let payload: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(`BASE_OAUTH_REFRESH_FAILED:HTTP_${response.status}:${safeBaseError(payload)}`);
  }
  const accessToken = payload?.access_token;
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    throw new Error("BASE_OAUTH_REFRESH_FAILED:ACCESS_TOKEN_MISSING");
  }
  const token = accessToken.trim();
  const expiresIn = Number(payload?.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    cachedBaseAccessToken = { token, expiresAt: Date.now() + expiresIn * 1000 };
  } else {
    cachedBaseAccessToken = null;
  }
  return token;
}

function baseRequestRetryable(error: unknown, status: number | null): boolean {
  if (status === 429 || (status !== null && status >= 500)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|aborted|ECONNRESET|ETIMEDOUT/i.test(message);
}

async function requestBase(
  path: string,
  body: URLSearchParams,
  attempts = 1,
): Promise<BaseItemResponse> {
  const tries = Math.min(3, Math.max(1, Math.floor(attempts)));
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const token = await getBaseAccessToken();
      const response = await fetch(`${BASE_API_URL}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      let data: BaseItemResponse | null = null;
      try {
        data = JSON.parse(text) as BaseItemResponse;
      } catch {
        data = null;
      }
      if (!response.ok) {
        const error = new Error(`BASE_API_REQUEST_FAILED:HTTP_${response.status}:${safeBaseError(data)}`);
        if (!baseRequestRetryable(error, response.status) || attempt === tries) throw error;
        lastError = error;
      } else {
        return data ?? { raw: text };
      }
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      if (!baseRequestRetryable(wrapped, null) || attempt === tries) throw wrapped;
      lastError = wrapped;
    }
    await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
  }
  throw lastError ?? new Error("BASE_API_REQUEST_FAILED");
}

export async function createBaseItem(input: BaseItemInput) {
  return requestBase(
    "/items/add",
    new URLSearchParams({
      title: input.title,
      ...(input.identifier ? { identifier: input.identifier } : {}),
      detail: input.detail,
      price: String(Math.round(input.price)),
      stock: String(Math.max(0, Math.floor(input.stock ?? 0))),
      visible: input.visible === false ? "0" : "1",
    }),
  );
}

export async function editBaseItem(input: {
  itemId: string;
  title: string;
  detail: string;
  price: number;
  stock?: number;
  visible?: boolean;
}) {
  return requestBase(
    "/items/edit",
    new URLSearchParams({
      item_id: input.itemId,
      title: input.title,
      detail: input.detail,
      price: String(Math.round(input.price)),
      stock: String(Math.max(0, Math.floor(input.stock ?? 0))),
      visible: input.visible === false ? "0" : "1",
    }),
    3,
  );
}


/** Read one existing BASE item by ID. This is read-only and never changes listing state. */
export async function getBaseItemDetail(itemId: string): Promise<Record<string, unknown>> {
  const normalizedId = String(itemId ?? "").trim();
  if (!/^\d+$/.test(normalizedId)) throw new Error("BASE_ITEM_DETAIL_ID_INVALID");
  const token = await getBaseAccessToken();
  const response = await fetch(`${BASE_API_URL}/items/detail/${encodeURIComponent(normalizedId)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let payload: Record<string, unknown> | null = null;
  try { payload = JSON.parse(text) as Record<string, unknown>; } catch { payload = null; }
  if (!response.ok) {
    throw new Error(`BASE_ITEM_DETAIL_FAILED:HTTP_${response.status}:${safeBaseError(payload)}`);
  }
  const item = payload?.item;
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("BASE_ITEM_DETAIL_RESPONSE_INVALID");
  }
  const record = item as Record<string, unknown>;
  const returnedId = String(record.item_id ?? "").trim();
  if (!returnedId || returnedId !== normalizedId) {
    // Fail closed: the detail endpoint must never authorize edits to a different
    // item or claim a requested listing was read back without its exact ID.
    throw new Error("BASE_ITEM_DETAIL_ID_MISMATCH");
  }
  return record;
}

/**
 * Deletes only allowlisted stale BASE item IDs after a dedicated route has
 * validated a complete snapshot and the canonical replacement. Never call from
 * ordinary reconciliation or cron flows.
 */
const BASE_STALE_ITEM_DELETE_ALLOWLIST = new Set([
  "163159366", "163159368", "163159369",
  "163125132", "163125145", "163130238", "163159274", "163159329",
]);

export async function deleteAllowlistedStaleBaseItem(itemId: string) {
  const normalizedId = String(itemId ?? "").trim();
  if (!BASE_STALE_ITEM_DELETE_ALLOWLIST.has(normalizedId)) {
    throw new Error("BASE_STALE_ITEM_DELETE_ID_NOT_ALLOWLISTED");
  }
  return requestBase("/items/delete", new URLSearchParams({ item_id: normalizedId }));
}

export async function addBaseItemImage(input: {
  itemId: string;
  imageNo: number;
  imageUrl: string;
}) {
  return requestBase(
    "/items/add_image",
    new URLSearchParams({
      item_id: input.itemId,
      image_no: String(Math.min(20, Math.max(1, Math.floor(input.imageNo)))),
      image_url: input.imageUrl,
    }),
  );
}

export type BaseOrderSummary = {
  unique_key: string;
  dispatch_status?: string;
  ordered?: number;
};

export type BaseOrderDetail = BaseOrderSummary & {
  payment?: string;
  total?: number;
  shipping_fee?: number;
  first_name?: string;
  last_name?: string;
  country?: string;
  country_code?: string;
  zip_code?: string;
  prefecture?: string;
  address?: string;
  address2?: string;
  mail_address?: string;
  tel?: string;
  remark?: string;
  add_comment?: string;
  tracking_number?: string;
  delivery_company_id?: number;
  c_c_payment_transaction?: { status?: string };
  cvs_payment_transaction?: { status?: string };
  bt_payment_transaction?: { status?: string };
  atobarai_payment_transaction?: { status?: string };
  carrier_payment_transaction?: { status?: string };
  paypal_payment_transaction?: { status?: string };
  amazon_payment_transaction?: { status?: string };
  paypay_payment_transaction?: { status?: string };
  bnpl_payment_transaction?: { status?: string };
  coin_payment_transaction?: { status?: string };
  order_receiver?: {
    first_name?: string;
    last_name?: string;
    zip_code?: string;
    prefecture?: string;
    address?: string;
    address2?: string;
    tel?: string;
    country?: string;
    country_code?: string;
  };
  order_items?: Array<{
    order_item_id?: string | number;
    item_id?: string | number;
    title?: string;
    price?: number;
    amount?: number;
    total?: number;
    status?: string;
  }>;
};

export async function listBaseOrders(options?: {
  startOrdered?: string;
  endOrdered?: string;
  limit?: number;
  offset?: number;
}): Promise<BaseOrderSummary[]> {
  const token = await getBaseAccessToken();
  const params = new URLSearchParams();
  if (options?.startOrdered) params.set("start_ordered", options.startOrdered);
  if (options?.endOrdered) params.set("end_ordered", options.endOrdered);
  params.set("limit", String(Math.min(100, Math.max(1, options?.limit ?? 100))));
  params.set("offset", String(Math.max(0, options?.offset ?? 0)));

  const response = await fetch(`${BASE_API_URL}/orders?${params.toString()}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) {
    let payload: unknown = null;
    try { payload = JSON.parse(text); } catch { payload = null; }
    throw new Error(`BASE_ORDERS_REQUEST_FAILED:HTTP_${response.status}:${safeBaseError(payload)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("BASE_ORDERS_RESPONSE_INVALID_JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("BASE_ORDERS_RESPONSE_INVALID");
  }
  const orders = (data as { orders?: unknown }).orders;
  if (!Array.isArray(orders)) {
    // Never turn an unexpected API envelope into a successful empty poll.
    // The caller should surface this as a failed poll for investigation.
    throw new Error("BASE_ORDERS_RESPONSE_MISSING_ORDERS_ARRAY");
  }
  return orders as BaseOrderSummary[];
}

export type BaseReadOnlyProbeResult = {
  orders: { apiStatus: 200; countReturned: number; dispatchStatuses: string[] };
  items: {
    apiStatus: number | null;
    countReturned: number;
    visibleCount: number;
    hiddenCount: number;
    unknownVisibilityCount: number;
    pages: number;
    complete: boolean;
    errorStage: string | null;
    /** Rows repeated across pages (an insert shifted offsets); skipped, not counted twice. */
    duplicateItemCount: number;
    /** Rows without an item_id; they cannot be matched to TRACER. */
    missingItemIdCount: number;
    entries: Array<{ itemId: string | null; identifier: string | null; visible: boolean | null }>;
  };
};

/**
 * Read-only BASE inventory probe. Uses one refreshed access token for all pages
 * and returns counts only; no item IDs, titles, or customer data leave this helper.
 */
/** Maximum BASE scan: 50 pages × 100 items = 5,000 items. A 1,000 item cap left the mapping audit incomplete. */
export const BASE_ITEMS_MAX_PAGES = 50;

export async function probeBaseReadOnly(options?: {
  itemPageLimit?: number;
  itemMaxPages?: number;
}): Promise<BaseReadOnlyProbeResult> {
  const token = await getBaseAccessToken();
  const requestJson = async (path: string, stage: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`${BASE_API_URL}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let payload: Record<string, unknown> | null = null;
    try { payload = JSON.parse(text) as Record<string, unknown>; } catch { payload = null; }
    if (!response.ok) {
      throw new Error(`${stage}:HTTP_${response.status}:${safeBaseError(payload)}`);
    }
    if (!payload) throw new Error(`${stage}:RESPONSE_INVALID`);
    return payload;
  };

  const orderPayload = await requestJson("/orders?limit=1&offset=0", "BASE_ORDERS_PROBE_FAILED");
  if (!Array.isArray(orderPayload.orders)) throw new Error("BASE_ORDERS_PROBE_RESPONSE_INVALID");
  const orderRows = orderPayload.orders as BaseOrderSummary[];
  const result: BaseReadOnlyProbeResult = {
    orders: {
      apiStatus: 200,
      countReturned: orderRows.length,
      dispatchStatuses: [...new Set(orderRows.map((order) => String(order.dispatch_status ?? "unknown")))].sort(),
    },
    items: {
      apiStatus: null,
      countReturned: 0,
      visibleCount: 0,
      hiddenCount: 0,
      unknownVisibilityCount: 0,
      pages: 0,
      complete: false,
      errorStage: null,
      duplicateItemCount: 0,
      missingItemIdCount: 0,
      entries: [],
    },
  };

  const pageLimit = Math.min(100, Math.max(1, Math.floor(options?.itemPageLimit ?? 100)));
  const maxPages = Math.min(BASE_ITEMS_MAX_PAGES, Math.max(1, Math.floor(options?.itemMaxPages ?? BASE_ITEMS_MAX_PAGES)));
  let offset = 0;
  const seenItemIds = new Set<string>();
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    try {
      const payload = await requestJson(
        `/items?limit=${pageLimit}&offset=${offset}`,
        "BASE_ITEMS_PROBE_FAILED",
      );
      if (!Array.isArray(payload.items)) throw new Error("BASE_ITEMS_PROBE_RESPONSE_INVALID");
      const rows = payload.items as Array<{ visible?: boolean | number | string }>;
      result.items.apiStatus = 200;
      result.items.pages += 1;
      for (const item of rows) {
        const raw = item as { item_id?: string | number; identifier?: unknown };
        const rawId = raw.item_id;
        const itemId = rawId == null || String(rawId).trim() === "" ? null : String(rawId);
        if (!itemId) result.items.missingItemIdCount += 1;
        const identifier = typeof raw.identifier === "string" && raw.identifier.trim() ? raw.identifier.trim() : null;
        const visible = item.visible === true || item.visible === 1 || item.visible === "1"
          ? true
          : item.visible === false || item.visible === 0 || item.visible === "0"
            ? false
            : null;
        if (itemId && seenItemIds.has(itemId)) {
          result.items.duplicateItemCount += 1;
          continue;
        }
        if (itemId) seenItemIds.add(itemId);
        result.items.countReturned += 1;
        result.items.entries.push({ itemId, identifier, visible });
        if (visible === true) {
          result.items.visibleCount += 1;
        } else if (visible === false) {
          result.items.hiddenCount += 1;
        } else {
          result.items.unknownVisibilityCount += 1;
        }
      }
      if (rows.length < pageLimit) {
        result.items.complete = true;
        break;
      }
      offset += rows.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : "BASE_ITEMS_PROBE_FAILED";
      result.items.apiStatus = Number(message.match(/HTTP_(\d{3})/)?.[1] ?? 0) || null;
      result.items.errorStage = message.split(":")[0].slice(0, 100);
      break;
    }
  }
  // Every page was full: the catalog may end exactly at the cap. One extra
  // single-row read decides it instead of reporting a full scan as partial.
  if (!result.items.complete && !result.items.errorStage && result.items.pages === maxPages) {
    try {
      const payload = await requestJson(`/items?limit=1&offset=${offset}`, "BASE_ITEMS_PROBE_FAILED");
      if (Array.isArray(payload.items) && payload.items.length === 0) result.items.complete = true;
      else result.items.errorStage = "BASE_ITEMS_SCAN_CAP_REACHED";
    } catch (error) {
      result.items.errorStage = (error instanceof Error ? error.message : "BASE_ITEMS_PROBE_FAILED").split(":")[0].slice(0, 100);
    }
  }

  return result;
}

export async function getBaseOrderDetail(uniqueKey: string): Promise<BaseOrderDetail> {
  const token = await getBaseAccessToken();
  const response = await fetch(
    `${BASE_API_URL}/orders/detail/${encodeURIComponent(uniqueKey)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
    },
  );
  const text = await response.text();
  if (!response.ok) {
    let payload: unknown = null;
    try { payload = JSON.parse(text); } catch { payload = null; }
    throw new Error(`BASE_ORDER_DETAIL_FAILED:HTTP_${response.status}:${safeBaseError(payload)}`);
  }
  const data = JSON.parse(text) as { order?: BaseOrderDetail };
  if (!data.order) throw new Error("BASE order detail missing order");
  return data.order;
}


/**
 * Fetches a complete, read-only product snapshot for an authenticated backup export.
 * This intentionally excludes orders and customer data. Never log returned item payloads.
 */
/** A page failed after retries. `items` are the pages already fetched, including any resumed rows. */
export class BaseSnapshotInterrupted extends Error {
  readonly items: Record<string, unknown>[];
  readonly checkpoint: BaseSnapshotCheckpoint;
  constructor(message: string, items: Record<string, unknown>[], checkpoint: BaseSnapshotCheckpoint) {
    super(message);
    this.name = "BaseSnapshotInterrupted";
    this.items = items;
    this.checkpoint = checkpoint;
  }
}

async function fetchBaseItemPage(
  token: string,
  pageLimit: number,
  offset: number,
): Promise<Record<string, unknown>[]> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${BASE_API_URL}/items?limit=${pageLimit}&offset=${offset}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      let payload: Record<string, unknown> | null = null;
      try { payload = JSON.parse(text) as Record<string, unknown>; } catch { payload = null; }
      if (!response.ok) {
        const error = new Error(`BASE_ITEMS_SNAPSHOT_FAILED:HTTP_${response.status}:${safeBaseError(payload)}`);
        if (!baseRequestRetryable(error, response.status) || attempt === 3) throw error;
        lastError = error;
      } else if (!payload || !Array.isArray(payload.items)) {
        throw new Error("BASE_ITEMS_SNAPSHOT_RESPONSE_INVALID");
      } else {
        const rows = payload.items.filter(
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
        );
        if (rows.length !== payload.items.length) throw new Error("BASE_ITEMS_SNAPSHOT_ROW_INVALID");
        return rows;
      }
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      if (wrapped.message.startsWith("BASE_ITEMS_SNAPSHOT_RESPONSE_INVALID") || wrapped.message.startsWith("BASE_ITEMS_SNAPSHOT_ROW_INVALID")) {
        throw wrapped;
      }
      if (!baseRequestRetryable(wrapped, null) || attempt === 3) throw wrapped;
      lastError = wrapped;
    }
    await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
  }
  throw lastError ?? new Error("BASE_ITEMS_SNAPSHOT_FAILED");
}

export async function fetchBaseItemsSnapshot(options?: {
  itemPageLimit?: number;
  itemMaxPages?: number;
  checkpoint?: BaseSnapshotCheckpoint;
  priorItems?: Record<string, unknown>[];
}): Promise<{ items: Record<string, unknown>[]; pages: number; complete: boolean; checkpoint: BaseSnapshotCheckpoint }> {
  const token = await getBaseAccessToken();
  const pageLimit = Math.min(100, Math.max(1, Math.floor(options?.itemPageLimit ?? 100)));
  const maxPages = Math.min(BASE_ITEMS_MAX_PAGES, Math.max(1, Math.floor(options?.itemMaxPages ?? BASE_ITEMS_MAX_PAGES)));
  const resumed = prepareSnapshotResume(options?.priorItems ?? [], options?.checkpoint);
  const items = resumed.items;
  const seenItemIds = resumed.seen;
  let pages = resumed.pages;
  let offset = resumed.offset;
  let complete = false;

  for (let pageIndex = pages; pageIndex < maxPages; pageIndex += 1) {
    let rows: Record<string, unknown>[];
    try {
      rows = await fetchBaseItemPage(token, pageLimit, offset);
    } catch (error) {
      const message = error instanceof Error ? error.message : "BASE_ITEMS_SNAPSHOT_FAILED";
      const checkpoint = { nextOffset: offset, pagesFetched: pages, itemIds: [...seenItemIds] };
      throw new BaseSnapshotInterrupted(
        `${message}:resumeOffset=${checkpoint.nextOffset}:pagesFetched=${checkpoint.pagesFetched}`,
        items,
        checkpoint,
      );
    }
    appendSnapshotRows(items, seenItemIds, rows);
    pages += 1;
    if (rows.length < pageLimit) {
      complete = true;
      break;
    }
    offset += rows.length;
  }
  // All pages full: confirm the catalog ends exactly at the cap before calling it incomplete.
  if (!complete && pages === maxPages) {
    try {
      const tail = await fetchBaseItemPage(token, 1, offset);
      if (tail.length === 0) complete = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "BASE_ITEMS_SNAPSHOT_FAILED";
      const checkpoint = { nextOffset: offset, pagesFetched: pages, itemIds: [...seenItemIds] };
      throw new BaseSnapshotInterrupted(
        `${message}:resumeOffset=${checkpoint.nextOffset}:pagesFetched=${checkpoint.pagesFetched}`,
        items,
        checkpoint,
      );
    }
  }

  if (!complete) throw new Error(`BASE_ITEMS_SNAPSHOT_INCOMPLETE:pages=${pages}:maxPages=${maxPages}`);
  const ids = items.map((item) => String(item.item_id ?? "")).filter(Boolean);
  if (ids.length !== items.length || new Set(ids).size !== ids.length) {
    throw new Error("BASE_ITEMS_SNAPSHOT_ID_MISSING_OR_DUPLICATE");
  }
  return {
    items,
    pages,
    complete,
    checkpoint: { nextOffset: offset, pagesFetched: pages, itemIds: ids },
  };
}


export type BaseDeliveryCompany = {
  delivery_company_id: number;
  name: string;
};

export async function listBaseDeliveryCompanies(): Promise<BaseDeliveryCompany[]> {
  const token = await getBaseAccessToken();
  const response = await fetch(`${BASE_API_URL}/delivery_companies`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let payload: Record<string, unknown> | null = null;
  try { payload = JSON.parse(text) as Record<string, unknown>; } catch { payload = null; }
  if (!response.ok) throw new Error(`BASE_DELIVERY_COMPANIES_FAILED:HTTP_${response.status}:${safeBaseError(payload)}`);
  const rows = payload?.delivery_companies;
  if (!Array.isArray(rows)) throw new Error("BASE_DELIVERY_COMPANIES_RESPONSE_INVALID");
  return rows.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const id = Number(row.delivery_company_id);
    const name = String(row.name ?? "").trim();
    return Number.isSafeInteger(id) && id >= 0 && name ? [{ delivery_company_id: id, name }] : [];
  });
}

export async function updateBaseOrderItemFulfillment(input: {
  orderItemId: string;
  trackingNumber: string;
  addComment?: string;
  atobarai?: boolean;
  deliveryCompanyId?: number;
}) {
  const orderItemId = input.orderItemId.trim();
  const trackingNumber = input.trackingNumber.trim();
  if (!orderItemId) throw new Error("BASE_ORDER_ITEM_ID_REQUIRED");
  if (!trackingNumber) throw new Error("BASE_TRACKING_NUMBER_REQUIRED");
  const body = new URLSearchParams({ order_item_id: orderItemId });
  if (input.atobarai) {
    if (!Number.isSafeInteger(input.deliveryCompanyId) || Number(input.deliveryCompanyId) < 0) {
      throw new Error("BASE_AFTERPAY_DELIVERY_COMPANY_REQUIRED");
    }
    if (!/^[A-Za-z0-9-]+$/.test(trackingNumber)) throw new Error("BASE_AFTERPAY_TRACKING_NUMBER_INVALID");
    body.set("atobarai_status", "shipping");
    body.set("delivery_company_id", String(input.deliveryCompanyId));
    body.set("tracking_number", trackingNumber);
  } else {
    body.set("status", "dispatched");
    body.set("add_comment", (input.addComment || ("[送り状番号]" + trackingNumber)).slice(0, 250));
  }
  return requestBase("/orders/edit_status", body);
}
