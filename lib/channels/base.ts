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

export function isBaseConfigured() {
  return Boolean(BASE_ACCESS_TOKEN || (
    BASE_CLIENT_ID && BASE_CLIENT_SECRET && BASE_REFRESH_TOKEN
  ));
}

async function getBaseAccessToken() {
  if (BASE_CLIENT_ID && BASE_CLIENT_SECRET && BASE_REFRESH_TOKEN) {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: BASE_CLIENT_ID,
      client_secret: BASE_CLIENT_SECRET,
      refresh_token: BASE_REFRESH_TOKEN,
      redirect_uri: process.env.BASE_REDIRECT_URI?.trim() || "",
    });

    const response = await fetch(`${BASE_API_URL}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`BASE OAuth refresh HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    const data = JSON.parse(text) as { access_token?: string };
    if (!data.access_token) throw new Error("BASE OAuth refresh did not return access_token");
    return data.access_token;
  }

  if (!BASE_ACCESS_TOKEN) {
    throw new Error("BASE API credentials are not configured");
  }
  return BASE_ACCESS_TOKEN;
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
    throw new Error(`BASE API HTTP ${response.status}: ${text.slice(0, 500)}`);
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
      stock: String(Math.max(0, Math.floor(input.stock ?? 1))),
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
  if (!response.ok) throw new Error(`BASE orders HTTP ${response.status}: ${text.slice(0, 500)}`);
  const data = JSON.parse(text) as { orders?: BaseOrderSummary[] };
  return data.orders ?? [];
}

export async function getBaseOrderDetail(uniqueKey: string): Promise<BaseOrderDetail> {
  const token = requireBaseToken();
  const response = await fetch(
    `${BASE_API_URL}/orders/detail/${encodeURIComponent(uniqueKey)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`BASE order detail HTTP ${response.status}: ${text.slice(0, 500)}`);
  const data = JSON.parse(text) as { order?: BaseOrderDetail };
  if (!data.order) throw new Error("BASE order detail missing order");
  return data.order;
}
