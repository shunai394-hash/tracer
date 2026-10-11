import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type BaseItemInput = {
  title: string;
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

type BaseOAuthTokenState = {
  refresh_token: string;
  access_token: string | null;
  access_token_expires_at: string | null;
  refresh_lease_until: string | null;
};

let cachedBaseAccessToken: { value: string; expiresAt: number } | null = null;
let baseRefreshInFlight: Promise<string> | null = null;

function isUsableAccessToken(state: BaseOAuthTokenState | null): state is BaseOAuthTokenState & { access_token: string; access_token_expires_at: string } {
  return Boolean(
    state?.access_token &&
    state.access_token_expires_at &&
    Date.parse(state.access_token_expires_at) > Date.now() + 60_000,
  );
}

async function readBaseTokenState(admin: ReturnType<typeof createSupabaseAdminClient>): Promise<BaseOAuthTokenState | null> {
  const { data, error } = await admin.rpc("get_channel_oauth_token_state", { p_provider: "base" });
  if (error) throw new Error("BASE_OAUTH_TOKEN_STORE_READ_FAILED");
  const row = Array.isArray(data) ? data[0] : null;
  return row && typeof row === "object" ? row as BaseOAuthTokenState : null;
}

async function refreshBaseAccessToken(): Promise<string> {
  if (!baseOAuthConfigReady()) {
    throw new Error("BASE_OAUTH_CONFIG_INCOMPLETE: configure BASE_CLIENT_ID, BASE_CLIENT_SECRET, BASE_REFRESH_TOKEN, and BASE_REDIRECT_URI");
  }

  const admin = createSupabaseAdminClient();
  const { error: seedError } = await admin.rpc("seed_channel_oauth_refresh_token", {
    p_provider: "base",
    p_refresh_token: BASE_REFRESH_TOKEN,
  });
  if (seedError) throw new Error("BASE_OAUTH_TOKEN_STORE_NOT_READY");

  const existing = await readBaseTokenState(admin);
  if (isUsableAccessToken(existing)) {
    cachedBaseAccessToken = { value: existing.access_token, expiresAt: Date.parse(existing.access_token_expires_at) };
    return existing.access_token;
  }

  const { data: claimed, error: claimError } = await admin.rpc("claim_channel_oauth_refresh", {
    p_provider: "base",
    p_lease_seconds: 30,
  });
  if (claimError) throw new Error("BASE_OAUTH_REFRESH_LOCK_FAILED");

  if (claimed !== true) {
    // Another serverless instance owns the refresh lease. Wait for its stored
    // access token rather than spending the same rotating refresh token twice.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const state = await readBaseTokenState(admin);
      if (isUsableAccessToken(state)) {
        cachedBaseAccessToken = { value: state.access_token, expiresAt: Date.parse(state.access_token_expires_at) };
        return state.access_token;
      }
    }
    throw new Error("BASE_OAUTH_REFRESH_LOCK_TIMEOUT");
  }

  try {
    const state = await readBaseTokenState(admin);
    const refreshToken = state?.refresh_token?.trim() || BASE_REFRESH_TOKEN;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: BASE_CLIENT_ID,
      client_secret: BASE_CLIENT_SECRET,
      refresh_token: refreshToken,
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
    try { payload = JSON.parse(text) as Record<string, unknown>; } catch { payload = null; }
    if (!response.ok) {
      throw new Error(`BASE_OAUTH_REFRESH_FAILED:HTTP_${response.status}:${safeBaseError(payload)}`);
    }

    const accessToken = payload?.access_token;
    if (typeof accessToken !== "string" || !accessToken.trim()) {
      throw new Error("BASE_OAUTH_REFRESH_FAILED:ACCESS_TOKEN_MISSING");
    }
    const nextRefreshToken = typeof payload?.refresh_token === "string" && payload.refresh_token.trim()
      ? payload.refresh_token.trim()
      : refreshToken;
    const expiresIn = Number(payload?.expires_in ?? 3600);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error("BASE_OAUTH_REFRESH_FAILED:INVALID_EXPIRY");
    }
    const expiresAt = new Date(Date.now() + Math.max(60, expiresIn - 60) * 1000).toISOString();
    const { error: storeError } = await admin.rpc("store_channel_oauth_tokens", {
      p_provider: "base",
      p_refresh_token: nextRefreshToken,
      p_access_token: accessToken.trim(),
      p_access_token_expires_at: expiresAt,
    });
    if (storeError) {
      // Do not use a token response if its potentially rotated refresh token
      // cannot be persisted; a future cold start could otherwise lose access.
      throw new Error("BASE_OAUTH_TOKEN_STORE_WRITE_FAILED");
    }

    cachedBaseAccessToken = { value: accessToken.trim(), expiresAt: Date.parse(expiresAt) };
    return accessToken.trim();
  } catch (error) {
    await admin.rpc("release_channel_oauth_refresh", { p_provider: "base" }).catch(() => undefined);
    throw error;
  }
}

async function getBaseAccessToken(): Promise<string> {
  if (cachedBaseAccessToken && cachedBaseAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedBaseAccessToken.value;
  }
  if (!baseRefreshInFlight) {
    baseRefreshInFlight = refreshBaseAccessToken().finally(() => { baseRefreshInFlight = null; });
  }
  return baseRefreshInFlight;
}

async function invalidateBaseAccessToken(): Promise<void> {
  cachedBaseAccessToken = null;
  const admin = createSupabaseAdminClient();
  const { error } = await admin.rpc("clear_channel_oauth_access_token", { p_provider: "base" });
  if (error) throw new Error("BASE_OAUTH_ACCESS_TOKEN_INVALIDATION_FAILED");
}

async function authorizedBaseFetch(url: string, init: RequestInit): Promise<Response> {
  const send = async (token: string) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers, cache: "no-store" });
  };
  let response = await send(await getBaseAccessToken());
  if (response.status !== 401) return response;

  await invalidateBaseAccessToken();
  response = await send(await getBaseAccessToken());
  return response;
}

async function requestBase(
  path: string,
  body: URLSearchParams,
): Promise<BaseItemResponse> {
  const response = await authorizedBaseFetch(`${BASE_API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });

  const text = await response.text();
  let data: BaseItemResponse | null = null;

  try {
    data = JSON.parse(text) as BaseItemResponse;
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(`BASE_API_REQUEST_FAILED:HTTP_${response.status}:${safeBaseError(data)}`);
  }

  return data ?? { raw: text };
}

export async function createBaseItem(input: BaseItemInput) {
  return requestBase(
    "/items/add",
    new URLSearchParams({
      title: input.title,
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
  );
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
  const params = new URLSearchParams();
  if (options?.startOrdered) params.set("start_ordered", options.startOrdered);
  if (options?.endOrdered) params.set("end_ordered", options.endOrdered);
  params.set("limit", String(Math.min(100, Math.max(1, options?.limit ?? 100))));
  params.set("offset", String(Math.max(0, options?.offset ?? 0)));

  const response = await authorizedBaseFetch(`${BASE_API_URL}/orders?${params.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const text = await response.text();
  if (!response.ok) {
    let payload: unknown = null;
    try { payload = JSON.parse(text); } catch { payload = null; }
    throw new Error(`BASE_ORDERS_REQUEST_FAILED:HTTP_${response.status}:${safeBaseError(payload)}`);
  }
  const data = JSON.parse(text) as { orders?: BaseOrderSummary[] };
  return data.orders ?? [];
}

export async function getBaseOrderDetail(uniqueKey: string): Promise<BaseOrderDetail> {
  const response = await authorizedBaseFetch(
    `${BASE_API_URL}/orders/detail/${encodeURIComponent(uniqueKey)}`,
    { method: "GET", headers: { Accept: "application/json" } },
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
