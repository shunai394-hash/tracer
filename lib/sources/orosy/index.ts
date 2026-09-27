import "server-only";

import { repairMojibake } from "@/lib/sources/orosy/client";
import { selectOrosyVariation } from "@/lib/sources/orosy/variation-selection";

import { orosyRequest } from "./client";

export { orosyRequest };

export type OrosyVariation = {
  variationId: string;
  jan: string | null;
  variantLabel: string | null;
  buyerPrice: number | null;
  listPrice: number | null;
  retailPrice: number | null;
  currency: string | null;
  madeToOrder: boolean;
  orderUnit: string | null;
  stockLevel: string | null;
  stockQty: number | null;
  expectedArrival: string | null;
};

export type OrosyProduct = {
  id: string;
  title: string;
  sku: string | null;
  price: number | null;
  currency: string | null;
  imageUrl: string | null;
  inventory: number | null;
  barcode: string | null;
  brand: string | null;
  category: string | null;
  deliveryGroup: string | null;
  retailPrice: number | null;
  orderable: boolean;
};

export type OrosyProductDetail = OrosyProduct & {
  productNumber: string | null;
  variations: OrosyVariation[];
  shipFromCountry: string | null;
};

type OrosyProductSearchItem = {
  product_id: string;
  title: string;
  brand?: string | null;
  images?: string[];
  category?: string | null;
  delivery_group?: string | null;
  min_buyer_price?: number | null;
  max_buyer_price?: number | null;
  min_retail_price?: number | null;
  max_retail_price?: number | null;
  variation_count?: number;
  has_preorder?: boolean;
  orderable?: boolean;
  language?: string | null;
  ship_from_country?: string | null;
};

type OrosyProductSearchResponse = {
  items: OrosyProductSearchItem[];
  page: number;
  per_page: number;
  total: number;
  campaign?: {
    code: string;
    label: string;
    rate_pct: number;
    ends_at: string;
  } | null;
};

type OrosyProductDetailResponse = {
  product_id: string;
  title: string;
  brand?: string | null;
  product_number?: string | null;
  delivery_group?: {
    group_code?: string | null;
  } | null;
  categories?: Array<{
    category_id?: string | null;
    name?: string | null;
  }>;
  images?: Array<{
    media_id?: string | null;
    url?: string | null;
    is_primary?: boolean;
  }>;
  variations?: Array<{
    variation_id: string;
    jan?: string | null;
    variant_label?: string | null;
    buyer_price?: number | null;
    list_price?: number | null;
    retail_price?: number | null;
    currency?: string | null;
    made_to_order?: boolean;
    order_unit?: string | null;
    stock_level?: string | null;
    stock_qty?: number | null;
    expected_arrival?: string | null;
  }>;
  orderable?: boolean;
  ship_from_country?: string | null;
};

type OrosyCartEstimateResponse = {
  shipping?: {
    status?: string | null;
    amount?: number | null;
    currency?: string | null;
  } | null;
  unresolved?: Array<{
    product_id?: string | null;
    reason?: string | null;
  }>;
};

export type OrosyShippingQuote = {
  amount: number | null;
  currency: string | null;
  status: string | null;
  unresolved: boolean;
};

export async function searchOrosyProducts(
  query: string,
): Promise<OrosyProduct[]> {
  const q = query.trim();

  if (!q) {
    return [];
  }

  const params = new URLSearchParams({
    q,
    currency: "JPY",
    min_stock: "1",
    preorder: "exclude",
    dest: "JP",
    page: "1",
    per_page: "100",
  });

  const response = await orosyRequest<OrosyProductSearchResponse>(
    `/products?${params.toString()}`,
  );

  console.log("[OROSY RAW]", JSON.stringify(response.items?.[0] ?? null));

  return response.items.map((item) => ({
    id: item.product_id,
    title: repairMojibake(item.title) ?? item.title,
    sku: null,
    price: item.min_buyer_price ?? null,
    currency: "JPY",
    imageUrl: item.images?.[0] ?? null,
    inventory: null,
    barcode: null,
    brand: repairMojibake(item.brand),
    category: repairMojibake(item.category),
    deliveryGroup: item.delivery_group ?? null,
    retailPrice: item.min_retail_price ?? null,
    orderable: item.orderable === true,
  }));
}

export async function getOrosyProductDetail(
  productId: string,
): Promise<OrosyProductDetail | null> {
  const id = productId.trim();

  if (!id) {
    return null;
  }

  const response = await orosyRequest<OrosyProductDetailResponse>(
    `/products/${encodeURIComponent(id)}?dest=JP`,
  );

  const variations = (response.variations ?? []).map((variation) => ({
    variationId: variation.variation_id,
    jan: variation.jan ?? null,
    variantLabel: variation.variant_label ?? null,
    buyerPrice: variation.buyer_price ?? null,
    listPrice: variation.list_price ?? null,
    retailPrice: variation.retail_price ?? null,
    currency: variation.currency ?? "JPY",
    madeToOrder: variation.made_to_order === true,
    orderUnit: variation.order_unit ?? null,
    stockLevel: variation.stock_level ?? null,
    stockQty: variation.stock_qty ?? null,
    expectedArrival: variation.expected_arrival ?? null,
  }));

  const usableVariation = selectOrosyVariation(variations);

  const image =
    response.images?.find((item) => item.is_primary)?.url ??
    response.images?.[0]?.url ??
    null;

  const category =
    response.categories?.find((item) => item.name)?.name ?? null;

  return {
    id: response.product_id,
    title: response.title,
    sku: null,
    price: usableVariation?.buyerPrice ?? null,
    currency: usableVariation?.currency ?? "JPY",
    imageUrl: image,
    inventory: usableVariation?.stockQty ?? null,
    barcode: usableVariation?.jan ?? null,
    brand: response.brand ?? null,
    category,
    deliveryGroup: response.delivery_group?.group_code ?? null,
    retailPrice: usableVariation?.retailPrice ?? null,
    orderable: response.orderable === true,
    productNumber: response.product_number ?? null,
    variations,
    shipFromCountry: response.ship_from_country ?? null,
  };
}

export async function getOrosyShippingQuote(
  productId: string,
): Promise<OrosyShippingQuote> {
  const id = productId.trim();

  if (!id) {
    return { amount: null, currency: null, status: null, unresolved: true };
  }

  const params = new URLSearchParams({
    dest: "JP",
    items: `${id}:1`,
  });
  const response = await orosyRequest<OrosyCartEstimateResponse>(
    `/cross-border/cart-estimate?${params.toString()}`,
  );
  const shipping = response.shipping ?? null;
  const amount =
    typeof shipping?.amount === "number" && Number.isFinite(shipping.amount)
      ? shipping.amount
      : null;

  return {
    amount,
    currency: shipping?.currency ?? null,
    status: shipping?.status ?? null,
    unresolved: (response.unresolved?.length ?? 0) > 0 || amount === null,
  };
}









