import "server-only";

import { CJConfigError, CJRequestError, fetchCJWithRateLimit, waitForCJRateLimit } from "@/lib/sources/cj/client";
import { getCJConfig } from "@/lib/config/env";

/**
 * CJ createOrderV2 contract checked against the official CJ API v2.0 docs.
 *
 * createOrderV2 requires shippingCountry, logisticName, and fromCountryCode
 * in addition to the destination address fields. TRACER currently does not
 * have a verified source for those values at live-order execution time, so
 * this function fails closed before authentication/network I/O when any of
 * them is missing.
 *
 * Source: https://developers.cjdropshipping.com/en/api/api2/api/shopping.html
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
  shippingAddress2?: string;
  shippingZip: string;
  shippingPhone: string;
  shippingCustomerName: string;
  remark?: string;
  email?: string;
  /** Required by CJ createOrderV2. Never guess this value. */
  logisticName?: string;
  /** Required by CJ createOrderV2. Never guess this value. */
  fromCountryCode?: string;
  /** Required by CJ createOrderV2. Human-readable destination country. */
  shippingCountry?: string;
  /** CJ payment mode: 2 = automatic balance payment, 3 = create-only. */
  payType?: 2 | 3;
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
    payId?: string;
    cjPayUrl?: string;
  };
};

async function getAccessTokenForOrder(): Promise<string> {
  const { apiKey } = getCJConfig();
  if (!apiKey) throw new CJConfigError();

  const response = await fetchCJWithRateLimit(
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
 * directly; go through the supplier execution gate. The caller owns idempotency,
 * kill-switch, inventory/profitability checks, and live-order enablement.
 *
 * CJ payType=2 is used by default so the order proceeds through CJ's balance
 * payment path instead of returning a deprecated payment-page URL.
 */
export async function createCJOrderV2(
  input: CJCreateOrderInput,
): Promise<CJCreateOrderResult> {
  if (input.products.length === 0) {
    throw new CJRequestError("order has no line items");
  }

  // Fail closed before obtaining a CJ access token. These are official
  // createOrderV2 required fields and TRACER must never invent them.
  const requiredFields: Array<[string, string | undefined]> = [
    ["shippingCountry", input.shippingCountry],
    ["logisticName", input.logisticName],
    ["fromCountryCode", input.fromCountryCode],
    ["shippingCountryCode", input.shippingCountryCode],
    ["shippingProvince", input.shippingProvince],
    ["shippingCity", input.shippingCity],
    ["shippingAddress", input.shippingAddress],
    ["shippingZip", input.shippingZip],
    ["shippingCustomerName", input.shippingCustomerName],
  ];
  const missingField = requiredFields.find(([, value]) => !value?.trim());
  if (missingField) {
    throw new CJRequestError(`required CJ createOrderV2 field is missing: ${missingField[0]}`);
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
    shippingCountry: input.shippingCountry,
    shippingProvince: input.shippingProvince,
    shippingCity: input.shippingCity,
    shippingAddress: input.shippingAddress,
    ...(input.shippingAddress2 ? { shippingAddress2: input.shippingAddress2 } : {}),
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
  body.logisticName = input.logisticName;
  body.fromCountryCode = input.fromCountryCode;
  // CJ defaults to deprecated page payment when payType is omitted.
  // Use balance payment so a live TRACER order does not stop at a payment page.
  body.payType = input.payType ?? 2;

  // Order creation claims the shared CJ QPS slot but is never auto-retried,
  // so a throttled or ambiguous response cannot create a duplicate order.
  await waitForCJRateLimit();
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

export type CJTrackingResult = {
  trackingNumber: string | null;
  carrier: string | null;
  trackingUrl: string | null;
  shippedAt: string | null;
  status: string | null;
  lastMileTrackingNumber: string | null;
  raw: unknown;
};

export async function getCJTrackingInfo(trackNumber: string): Promise<CJTrackingResult | null> {
  const normalized = trackNumber.trim();
  if (!normalized) return null;
  const token = await getAccessTokenForOrder();
  const params = new URLSearchParams({ trackNumber: normalized });
  const response = await fetchCJWithRateLimit(
    `https://developers.cjdropshipping.com/api2.0/v1/logistic/trackInfo?${params.toString()}`,
    {
      method: "GET",
      headers: { "CJ-Access-Token": token },
      cache: "no-store",
    },
  );
  if (!response.ok) {
    throw new CJRequestError(`CJ tracking lookup failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    data?: Array<{
      trackingNumber?: string;
      logisticName?: string;
      trackingStatus?: string;
      deliveryTime?: string;
      lastMileCarrier?: string;
      lastTrackNumber?: string;
    }>;
  };
  const item = payload.data?.[0];
  if (!item) return null;
  return {
    trackingNumber: item.trackingNumber ?? normalized,
    carrier: item.lastMileCarrier ?? item.logisticName ?? null,
    trackingUrl: null,
    shippedAt: item.deliveryTime ?? null,
    status: item.trackingStatus ?? null,
    lastMileTrackingNumber: item.lastTrackNumber ?? null,
    raw: payload,
  };
}

/**
 * Status/tracking parsing remains intentionally defensive because supplier
 * status vocabulary can vary across CJ order states. The endpoint itself is
 * documented by CJ API v2.0.
 */
export type CJOrderStatusResult = {
  status: string | null;
  trackingNumber: string | null;
  paymentDate: string | null;
  paymentDateTime: number | null;
  raw: unknown;
};

export async function getCJOrderStatus(supplierOrderId: string): Promise<CJOrderStatusResult> {
  const token = await getAccessTokenForOrder();
  const params = new URLSearchParams({ orderId: supplierOrderId });
  const response = await fetchCJWithRateLimit(
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
      paymentDate?: string;
      paymentDateTime?: number;
    };
  };
  const status = payload.data?.orderStatus ?? payload.data?.status ?? null;
  const trackingNumber =
    payload.data?.trackNumber ?? payload.data?.trackingNumber ?? payload.data?.logisticNo ?? null;

  const paymentDate =
    typeof payload.data?.paymentDate === "string" && payload.data.paymentDate.trim()
      ? payload.data.paymentDate
      : null;

  const paymentDateTime =
    typeof payload.data?.paymentDateTime === "number" &&
    Number.isFinite(payload.data.paymentDateTime)
      ? payload.data.paymentDateTime
      : null;

  return {
    status,
    trackingNumber,
    paymentDate,
    paymentDateTime,
    raw: payload,
  };
}
