import "server-only";

import { CJConfigError, CJRequestError } from "@/lib/sources/cj/client";
import { getCJConfig } from "@/lib/config/env";

/**
 * UNVERIFIED FIELD MAPPING — read this before enabling live ordering.
 *
 * developers.cjdropshipping.com and developers.cjdropshipping.cn are both
 * blocked by this environment's network egress proxy (EGRESS_BLOCKED). The
 * "CJ Docs > API v2.0 > shopping.html" page describing createOrderV2 could
 * not be fetched and read directly here. The field names below come from
 * search-engine-indexed secondary sources (an AI-summarized web search
 * result), not a primary document this code read itself. They are a
 * best-effort reconstruction, not a confirmed official contract.
 *
 * This is why executeLivePurchaseOrder() requires BOTH CJ_LIVE_ORDERING=1
 * AND an explicit per-order human confirmation (purchase_orders.human_confirmed_at)
 * before this function is ever called — see lib/ordering/dropship.ts. A
 * human must compare this against the live CJ developer docs before relying
 * on it for a real purchase.
 */
export type CJOrderProduct = {
  vid: string;
  quantity: number;
  /** Optional line-item reference echoed back by CJ in some API versions per secondary sources; harmless if ignored. */
  storeLineItemId?: string;
};

export type CJCreateOrderInput = {
  orderNumber: string;
  shippingCountryCode: string;
  shippingProvince: string;
  shippingCity: string;
  shippingAddress: string;
  shippingZip: string;
  shippingPhone: string;
  shippingCustomerName: string;
  /** Optional — only sent when the caller has a real value; never guessed. */
  remark?: string;
  email?: string;
  logisticName?: string;
  /** Optional — CJ's valid values for this field were not corroborated; omit unless explicitly configured. */
  fromCountryCode?: string;
  products: CJOrderProduct[];
};

type CJCreateOrderResponse = {
  code?: number;
  result?: boolean;
  message?: string;
  requestId?: string;
  data?: {
    orderId?: string;
    cjOrderId?: string;
    orderNum?: string;
  };
};

async function getAccessTokenForOrder(): Promise<string> {
  const { apiKey } = getCJConfig();
  if (!apiKey) throw new CJConfigError();

  const response = await fetch(
    "https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new CJRequestError(`CJ authentication failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: { accessToken?: string };
    message?: string;
  };
  const accessToken = payload.data?.accessToken;
  if (!accessToken) {
    throw new CJRequestError(payload.message || "CJ access token was not returned");
  }
  return accessToken;
}

export type CJCreateOrderResult = {
  succeeded: boolean;
  supplierOrderId: string | null;
  responseCode: string | null;
  responseMessage: string | null;
  raw: unknown;
};

/**
 * Places a real order with CJdropshipping. Caller is responsible for idempotency
 * (do not call twice for the same orderNumber), kill-switch checks, gate
 * evaluation, and the human-confirmation requirement — this function performs
 * the network call only, and always fires it if called. Do not call this
 * directly; go through lib/ordering/dropship.ts#executeLivePurchaseOrder.
 */
export async function createCJOrderV2(
  input: CJCreateOrderInput,
): Promise<CJCreateOrderResult> {
  if (input.products.length === 0) {
    throw new CJRequestError("order has no line items");
  }
  for (const product of input.products) {
    if (!product.vid) throw new CJRequestError("variant id (vid) is unknown for a line item");
    if (!Number.isFinite(product.quantity) || product.quantity <= 0) {
      throw new CJRequestError("quantity is unknown or invalid for a line item");
    }
  }

  const token = await getAccessTokenForOrder();

  const body: Record<string, unknown> = {
    orderNumber: input.orderNumber,
    shippingZip: input.shippingZip,
    shippingCountryCode: input.shippingCountryCode,
    shippingProvince: input.shippingProvince,
    shippingCity: input.shippingCity,
    shippingAddress: input.shippingAddress,
    shippingCustomerName: input.shippingCustomerName,
    shippingPhone: input.shippingPhone,
    products: input.products.map((product) => ({
      vid: product.vid,
      quantity: product.quantity,
      ...(product.storeLineItemId ? { storeLineItemId: product.storeLineItemId } : {}),
    })),
  };
  if (input.remark) body.remark = input.remark;
  if (input.email) body.email = input.email;
  if (input.logisticName) body.logisticName = input.logisticName;
  if (input.fromCountryCode) body.fromCountryCode = input.fromCountryCode;

  const response = await fetch(
    "https://developers.cjdropshipping.com/api2.0/v1/shopping/order/createOrderV2",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CJ-Access-Token": token,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    },
  );

  const payload = (await response.json().catch(() => null)) as CJCreateOrderResponse | null;

  if (!response.ok || !payload) {
    return {
      succeeded: false,
      supplierOrderId: null,
      responseCode: String(response.status),
      responseMessage: payload?.message ?? `HTTP ${response.status}`,
      raw: payload,
    };
  }

  const succeeded = payload.result === true;
  const supplierOrderId =
    payload.data?.orderId ?? payload.data?.cjOrderId ?? payload.data?.orderNum ?? null;

  return {
    succeeded,
    supplierOrderId: succeeded ? supplierOrderId : null,
    responseCode: payload.code !== undefined ? String(payload.code) : null,
    responseMessage: payload.message ?? null,
    raw: payload,
  };
}

/**
 * UNVERIFIED — the endpoint path is a low-confidence guess (weakly
 * corroborated by search, not read from the primary doc — see module header).
 * The status/tracking field names below were not corroborated by any source
 * found, so parsing is deliberately generic and defensive: it never assumes
 * a specific status vocabulary, and always returns the raw payload so a
 * human can inspect what CJ actually sent before this is trusted anywhere.
 */
export type CJOrderStatusResult = {
  status: string | null;
  trackingNumber: string | null;
  raw: unknown;
};

export async function getCJOrderStatus(supplierOrderId: string): Promise<CJOrderStatusResult> {
  const token = await getAccessTokenForOrder();
  const params = new URLSearchParams({ orderId: supplierOrderId });
  const response = await fetch(
    `https://developers.cjdropshipping.com/api2.0/v1/shopping/order/getOrderDetail?${params.toString()}`,
    {
      method: "GET",
      headers: { "CJ-Access-Token": token },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new CJRequestError(`CJ order status lookup failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: {
      orderStatus?: string;
      status?: string;
      trackNumber?: string;
      trackingNumber?: string;
      logisticNo?: string;
    };
  };
  const status = payload.data?.orderStatus ?? payload.data?.status ?? null;
  const trackingNumber =
    payload.data?.trackNumber ?? payload.data?.trackingNumber ?? payload.data?.logisticNo ?? null;
  return { status, trackingNumber, raw: payload };
}
