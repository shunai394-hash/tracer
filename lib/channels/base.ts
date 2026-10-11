import "server-only";

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
const BASE_ACCESS_TOKEN = process.env.BASE_ACCESS_TOKEN?.trim() || "";
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
    ? value.replace(/(?:access|refresh)_token[=: ]+[^\\s,;]+/gi, "[REDACTED]")
        .replace(/client_secret[=: ]+[^\\s,;]+/gi, "[REDACTED]")
        .slice(0, 180)
    : "unknown_error";
}

export function isBaseConfigured() {
  // A standalone access token is not accepted as proof of a working BASE
  // integration. Only the complete OAuth refresh configuration is supported.
  return baseOAuthConfigReady();
}

async function getBaseAccessToken(): Promise<string> {
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
  return accessToken.trim();
}

async function requestBase(
  path: string,
  body: URLSearchParams,
): Promise<BaseItemResponse> {
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
  const data = JSON.parse(text) as { orders?: BaseOrderSummary[] };
  return data.orders ?? [];
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
