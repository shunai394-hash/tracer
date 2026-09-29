import "server-only";

import { getPrintfulConfig } from "@/lib/config/env";

export class PrintfulConfigError extends Error {
  readonly code = "PRINTFUL_NOT_CONFIGURED" as const;
  constructor(message = "Printful is not configured") {
    super(message);
    this.name = "PrintfulConfigError";
  }
}

export class PrintfulRequestError extends Error {
  readonly code = "PRINTFUL_REQUEST_FAILED" as const;
  constructor(message = "Printful request failed") {
    super(message);
    this.name = "PrintfulRequestError";
  }
}

type PrintfulProduct = {
  id?: number;
  type_name?: string;
  title?: string;
  brand?: string | null;
  currency?: string;
  image?: string | null;
  is_discontinued?: boolean;
};

type PrintfulVariant = {
  id?: number;
  product_id?: number;
  name?: string;
  sku?: string | null;
  size?: string | null;
  color?: string | null;
  price?: string | number | null;
  currency?: string | null;
  image?: string | null;
  in_stock?: boolean | null;
};

type ProductResponse = {
  code?: number;
  result?: {
    product?: PrintfulProduct;
    variants?: PrintfulVariant[];
  };
};

type VariantResponse = {
  code?: number;
  result?: {
    variant?: PrintfulVariant;
    product?: PrintfulProduct;
  };
};

type ProductsResponse = {
  code?: number;
  result?: PrintfulProduct[];
};

type ShippingResponse = {
  code?: number;
  result?: Array<{
    id?: string;
    name?: string;
    rate?: string | number;
    currency?: string;
  }>;
};

type OrderResponse = {
  code?: number;
  result?: {
    id?: number;
    status?: string;
    created?: number;
    shipments?: Array<{
      tracking_number?: string | null;
      carrier?: string | null;
      service?: string | null;
      tracking_url?: string | null;
      shipped_at?: number | null;
    }>;
  };
};

function getConfig() {
  const config = getPrintfulConfig();
  if (!config.accessToken) throw new PrintfulConfigError();
  return config;
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const { accessToken, storeId } = getConfig();
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (storeId) headers.set("X-PF-Store-Id", storeId);

  const response = await fetch(`https://api.printful.com/${path.replace(/^\//, "")}`, {
    ...init,
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    throw new PrintfulRequestError(
      `Printful request failed with HTTP ${response.status}`,
    );
  }

  return (await response.json()) as T;
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizePrintfulVariant(
  variant: PrintfulVariant,
  product?: PrintfulProduct | null,
) {
  const id = variant.id;
  if (!id) return null;

  return {
    id: String(id),
    productId: variant.product_id ? String(variant.product_id) : product?.id ? String(product.id) : "",
    title: variant.name?.trim() || product?.title?.trim() || `Printful variant ${id}`,
    sku: variant.sku?.trim() || null,
    price: numberValue(variant.price),
    currency: (variant.currency ?? product?.currency ?? "USD").toUpperCase(),
    inventory: variant.in_stock === null || variant.in_stock === undefined
      ? null
      : variant.in_stock ? 1 : 0,
    inStock: variant.in_stock ?? null,
  };
}

export async function searchPrintfulProducts(query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  const payload = await request<ProductsResponse>("products");
  return (payload.result ?? [])
    .filter((product) => {
      const haystack = [
        product.title,
        product.type_name,
        product.brand,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(normalized);
    })
    .map((product) => {
      const id = product.id;
      if (!id || !product.title) return null;
      return {
        id: String(id),
        title: product.title,
        currency: (product.currency ?? "USD").toUpperCase(),
        imageUrl: product.image ?? null,
        discontinued: product.is_discontinued === true,
      };
    })
    .filter((product): product is NonNullable<typeof product> => product !== null);
}

export async function getPrintfulProduct(productId: string) {
  const id = Number(productId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const payload = await request<ProductResponse>(`products/${id}`);
  const product = payload.result?.product;
  if (!product?.id || !product.title) return null;

  return {
    id: String(product.id),
    title: product.title,
    currency: (product.currency ?? "USD").toUpperCase(),
    imageUrl: product.image ?? null,
    discontinued: product.is_discontinued === true,
    variants: (payload.result?.variants ?? [])
      .map((variant) => normalizePrintfulVariant(variant, product))
      .filter((variant): variant is NonNullable<typeof variant> => variant !== null),
  };
}

export async function getPrintfulVariant(variantId: string) {
  const id = Number(variantId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const payload = await request<VariantResponse>(`products/variant/${id}`);
  const variant = payload.result?.variant;
  if (!variant) return null;

  return normalizePrintfulVariant(variant, payload.result?.product);
}

export async function getPrintfulShippingRate(
  variantId: string,
  destinationCountryCode: string,
  quantity: number,
) {
  const id = Number(variantId);
  const qty = Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1;
  if (!Number.isInteger(id) || id <= 0 || !destinationCountryCode.trim()) return null;

  const payload = await request<ShippingResponse>("shipping/rates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { country_code: destinationCountryCode.trim().toUpperCase() },
      items: [{ variant_id: id, quantity: qty }],
      currency: "USD",
      locale: "en_US",
    }),
  });

  const rates = (payload.result ?? [])
    .map((rate) => {
      const amount = numberValue(rate.rate);
      const name = rate.name?.trim() || rate.id?.trim() || "";
      if (!name || amount === null) return null;
      return {
        name,
        amount,
        currency: (rate.currency ?? "USD").toUpperCase(),
      };
    })
    .filter((rate): rate is NonNullable<typeof rate> => rate !== null)
    .sort((a, b) => a.amount - b.amount);

  return rates[0] ?? null;
}

export async function getPrintfulOrder(orderId: string) {
  const id = orderId.trim();
  if (!id) return null;

  const payload = await request<OrderResponse>(`orders/${encodeURIComponent(id)}`);
  const order = payload.result;
  if (!order?.id) return null;

  const shipment = order.shipments?.find((item) => item.tracking_number) ?? order.shipments?.[0] ?? null;
  return {
    id: String(order.id),
    status: order.status ?? null,
    createdAt: typeof order.created === "number"
      ? new Date(order.created * 1000).toISOString()
      : null,
    trackingNumber: shipment?.tracking_number ?? null,
    carrier: shipment?.carrier ?? null,
    trackingUrl: shipment?.tracking_url ?? null,
    shippedAt: typeof shipment?.shipped_at === "number"
      ? new Date(shipment.shipped_at * 1000).toISOString()
      : null,
  };
}
