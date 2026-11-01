import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const MIN_EXPECTED_PROFIT_JPY = 2500;

export type CommerceChannel = "base" | "shopify";
export type OfferInput = {
  supplierCode: string; supplierProductId: string; supplierVariantId: string;
  supplierUrl?: string | null; currency: string; unitCost: number; shippingCost: number;
  inventory: number; shipTo?: string; trackingSupported: boolean; sourceStatus?: "discovered" | "verified" | "unavailable" | "error"; lastCheckedAt?: string | null; rawData?: Record<string, unknown>;
};

export function isCanonicalCjNativeId(value: unknown): value is string {
  return typeof value === "string" && /^\d{10,25}$/.test(value.trim());
}

const required = (value: unknown, field: string) => {
  const result = String(value ?? "").trim();
  if (!result) throw new Error("missing_" + field);
  return result;
};

export function calculateSellingPrice(input: {
  unitCostJpy: number; shippingCostJpy: number; feeRate: number;
  fixedFeeJpy?: number; targetMarginRate?: number;
}) {
  const unitCostJpy = input.unitCostJpy;
  const shippingCostJpy = input.shippingCostJpy;
  const feeRate = input.feeRate;
  const fixedFeeJpy = input.fixedFeeJpy ?? 0;
  const targetMarginRate = input.targetMarginRate ?? 0.5;
  const values = { unitCostJpy, shippingCostJpy, feeRate, fixedFeeJpy, targetMarginRate };
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isFinite(value) || value < 0) throw new Error("invalid_" + key);
  }
  if (feeRate + targetMarginRate >= 1) throw new Error("invalid_rate");
  const base = unitCostJpy + shippingCostJpy + fixedFeeJpy;
  let sellingPrice = Math.ceil(base / (1 - feeRate - targetMarginRate));
  let feeAmount = 0;
  let expectedProfit = 0;
  for (let i = 0; i < 10000; i++) {
    feeAmount = Math.ceil(sellingPrice * feeRate) + fixedFeeJpy;
    expectedProfit = sellingPrice - unitCostJpy - shippingCostJpy - feeAmount;
    if (expectedProfit > 0 && expectedProfit / sellingPrice >= targetMarginRate) break;
    sellingPrice += 1;
  }
  if (expectedProfit <= 0 || expectedProfit / sellingPrice < targetMarginRate) throw new Error("price_calculation_did_not_converge");
  return { sellingPrice, feeAmount, expectedProfit, marginRate: expectedProfit / sellingPrice };
}

/** Canonical upsert: supplier-native product and variant IDs remain first-class keys. */
export async function upsertSupplierOffer(input: {
  sourceKey: string; titleJa: string; descriptionJa?: string; brand?: string | null;
  category?: string | null; imageUrl?: string | null; sourceUrl?: string | null;
  sourceVariantKey: string; variantTitleJa?: string; sku?: string | null;
  attributes?: Record<string, unknown>; metadata?: Record<string, unknown>; offer: OfferInput;
}) {
  const sourceKey = required(input.sourceKey, "source_key");
  const supplierCode = required(input.offer.supplierCode, "supplier_code").toLowerCase();
  const supplierProductId = required(input.offer.supplierProductId, "supplier_product_id");
  const supplierVariantId = required(input.offer.supplierVariantId, "supplier_variant_id");
  if (supplierCode === "cj" && (!isCanonicalCjNativeId(supplierProductId) || !isCanonicalCjNativeId(supplierVariantId))) {
    throw new Error("invalid_cj_native_supplier_ids");
  }
  if (!Number.isFinite(input.offer.unitCost) || input.offer.unitCost < 0) throw new Error("invalid_unit_cost");
  if (!Number.isFinite(input.offer.shippingCost) || input.offer.shippingCost < 0) throw new Error("invalid_shipping_cost");
  if (!Number.isInteger(input.offer.inventory) || input.offer.inventory < 0) throw new Error("invalid_inventory");
  const supabase = createSupabaseAdminClient();
  const productPayload = {
    source_key: sourceKey, title_ja: required(input.titleJa, "title_ja"),
    description_ja: input.descriptionJa ?? "", brand: input.brand ?? null, category: input.category ?? null,
    image_url: input.imageUrl ?? null, source_url: input.sourceUrl ?? null, updated_at: new Date().toISOString(),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  const { data: product, error: productError } = await supabase.from("commerce_products").upsert(
    productPayload, { onConflict: "source_key" }
  ).select("id").single();
  if (productError || !product) throw new Error("product_upsert_failed:" + (productError?.message ?? "no_row"));
  const { data: variant, error: variantError } = await supabase.from("commerce_variants").upsert({
    product_id: product.id, source_variant_key: required(input.sourceVariantKey, "source_variant_key"),
    title_ja: input.variantTitleJa ?? "標準", sku: input.sku ?? null, attributes: input.attributes ?? {},
    updated_at: new Date().toISOString()
  }, { onConflict: "product_id,source_variant_key" }).select("id").single();
  if (variantError || !variant) throw new Error("variant_upsert_failed:" + (variantError?.message ?? "no_row"));
  const { data: offer, error: offerError } = await supabase.from("supplier_offers").upsert({
    variant_id: variant.id, supplier_code: supplierCode, supplier_product_id: supplierProductId,
    supplier_variant_id: supplierVariantId, supplier_url: input.offer.supplierUrl ?? null,
    currency: required(input.offer.currency, "currency").toUpperCase(), unit_cost: input.offer.unitCost,
    shipping_cost: input.offer.shippingCost, inventory: input.offer.inventory, ship_to: input.offer.shipTo ?? "JP",
    tracking_supported: input.offer.trackingSupported, source_status: input.offer.sourceStatus ?? "discovered",
    last_checked_at: input.offer.lastCheckedAt ?? null, raw_data: input.offer.rawData ?? {},
    updated_at: new Date().toISOString()
  }, { onConflict: "supplier_code,supplier_product_id,supplier_variant_id" }).select("id").single();
  if (offerError || !offer) throw new Error("offer_upsert_failed:" + (offerError?.message ?? "no_row"));
  return { productId: product.id as string, variantId: variant.id as string, offerId: offer.id as string };
}

export async function recalculatePrice(input: {
  variantId: string; offerId: string; exchangeRateToJpy: number; feeRate: number;
  fixedFeeJpy?: number; targetMarginRate?: number;
}) {
  if (!Number.isFinite(input.exchangeRateToJpy) || input.exchangeRateToJpy <= 0) throw new Error("invalid_exchange_rate");
  const db = createSupabaseAdminClient();
  const { data: offer, error } = await db.from("supplier_offers")
    .select("id,variant_id,supplier_code,supplier_product_id,supplier_variant_id,currency,unit_cost,shipping_cost,inventory,ship_to,source_status,tracking_supported,last_checked_at")
    .eq("id", input.offerId).eq("variant_id", input.variantId).single();
  if (error || !offer) throw new Error("supplier_offer_not_found:" + (error?.message ?? ""));
  if (offer.supplier_code === "cj" && (!isCanonicalCjNativeId(offer.supplier_product_id) || !isCanonicalCjNativeId(offer.supplier_variant_id))) {
    throw new Error("invalid_cj_native_supplier_ids");
  }
  // Price any correctly linked offer with known non-negative costs. Live stock,
  // destination support, tracking and orderability are checked at procurement time,
  // not used to prevent the catalog from calculating a sale price.
  const unitCostJpy = Math.ceil(Number(offer.unit_cost) * input.exchangeRateToJpy);
  const shippingCostJpy = Math.ceil(Number(offer.shipping_cost) * input.exchangeRateToJpy);
  const minimumPrice = calculateSellingPrice({
    unitCostJpy, shippingCostJpy,
    feeRate: input.feeRate, fixedFeeJpy: input.fixedFeeJpy, targetMarginRate: input.targetMarginRate
  });
  // Unify both storefronts at the highest existing price, but never below the 50% net-margin floor.
  const { data: channelPrices, error: channelPricesError } = await db.from("channel_listings")
    .select("selling_price")
    .eq("variant_id", input.variantId);
  if (channelPricesError) throw new Error("channel_price_read_failed:" + channelPricesError.message);
  const highestExistingPrice = Math.max(0, ...(channelPrices ?? [])
    .map((row) => Number(row.selling_price))
    .filter((value) => Number.isFinite(value) && value > 0));
  const minimumProfitPrice = Math.ceil((unitCostJpy + shippingCostJpy + (input.fixedFeeJpy ?? 0) + MIN_EXPECTED_PROFIT_JPY + 1) / (1 - input.feeRate));
  const sellingPrice = Math.max(minimumPrice.sellingPrice, highestExistingPrice, minimumProfitPrice);
  const feeAmount = Math.ceil(sellingPrice * input.feeRate) + (input.fixedFeeJpy ?? 0);
  const expectedProfit = sellingPrice - unitCostJpy - shippingCostJpy - feeAmount;
  const marginRate = expectedProfit / sellingPrice;
  if (expectedProfit <= 0 || marginRate + Number.EPSILON < (input.targetMarginRate ?? 0.5)) {
    throw new Error("non_positive_profit_or_margin_below_target");
  }
  const price = { sellingPrice, feeAmount, expectedProfit, marginRate };
  const { error: saveError } = await db.from("commerce_prices").upsert({
    variant_id: input.variantId, supplier_offer_id: input.offerId, currency: "JPY", selling_price: price.sellingPrice,
    fee_amount: price.feeAmount, expected_profit: price.expectedProfit,
    margin_rate: price.marginRate, calculated_at: new Date().toISOString()
  }, { onConflict: "variant_id" });
  if (saveError) throw new Error("price_upsert_failed:" + saveError.message);
  return price;
}

/** Channel state is independent. No identity_status flag is used to suppress a valid catalog listing. */
export async function getPublicationCandidates(channel: CommerceChannel, limit = 100) {
  const db = createSupabaseAdminClient();
  const { data, error } = await db.from("commerce_variants")
    .select("id,source_variant_key,title_ja,sku,commerce_products!inner(id,source_key,title_ja,description_ja,image_url,active),supplier_offers!inner(id,supplier_code,supplier_product_id,supplier_variant_id,supplier_url,currency,unit_cost,shipping_cost,inventory,ship_to,tracking_supported,source_status),commerce_prices!inner(currency,selling_price,expected_profit,fee_amount,margin_rate)")
    .eq("commerce_products.active", true).eq("commerce_prices.currency", "JPY")
    .gte("commerce_prices.expected_profit", MIN_EXPECTED_PROFIT_JPY).order("updated_at", { ascending: false })
    .limit(Math.min(500, Math.max(1, Math.floor(limit))));
  if (error) throw new Error("publication_candidates_failed:" + error.message);
  // Catalog eligibility is profit-first. Current stock, tracking, and live-order
  // readiness are handled by fulfillment, not used to suppress profitable listings.
  return (data ?? []).map((row) => ({ ...row, channel }));
}

/** Persist paid orders and procurement intents idempotently; supplier submission happens in a separate worker. */
export async function ingestPaidOrder(input: {
  channel: CommerceChannel; externalOrderId: string; totalAmount: number; customerName?: string | null;
  shippingAddress: Record<string, unknown>; rawPayload: Record<string, unknown>;
  lines: Array<{ externalLineId: string; variantId: string; sku?: string | null; quantity: number; unitPrice: number; offerId: string; selection?: Record<string, unknown> }>;
}) {
  required(input.externalOrderId, "external_order_id");
  if (!Number.isFinite(input.totalAmount) || input.totalAmount < 0 || input.lines.length === 0) throw new Error("invalid_order");
  for (const line of input.lines) {
    required(line.externalLineId, "external_line_id"); required(line.variantId, "variant_id"); required(line.offerId, "offer_id");
    if (!Number.isInteger(line.quantity) || line.quantity <= 0 || !Number.isFinite(line.unitPrice) || line.unitPrice < 0) throw new Error("invalid_order_line");
  }
  const db = createSupabaseAdminClient();
  const offersById = new Map<string, {
    id: string; variant_id: string; supplier_code: string;
    supplier_product_id: string; supplier_variant_id: string;
  }>();
  // Intake persists paid orders even when fulfillment evidence is stale or incomplete.
  // The procurement worker rechecks live stock, destination, tracking, price and IDs
  // before any supplier call; intake only requires an exact, existing supplier offer.
  for (const line of input.lines) {
    const { data: offer, error: offerError } = await db.from("supplier_offers")
      .select("id,variant_id,supplier_code,supplier_product_id,supplier_variant_id")
      .eq("id", line.offerId).eq("variant_id", line.variantId).maybeSingle();
    if (offerError || !offer) throw new Error("order_line_supplier_offer_missing");
    if (!String(offer.supplier_code ?? "").trim() ||
        !String(offer.supplier_product_id ?? "").trim() ||
        !String(offer.supplier_variant_id ?? "").trim()) {
      throw new Error("order_line_supplier_identity_missing");
    }
    offersById.set(line.offerId, offer as {
      id: string; variant_id: string; supplier_code: string;
      supplier_product_id: string; supplier_variant_id: string;
    });
  }
  const { data: order, error } = await db.from("commerce_orders").upsert({
    channel: input.channel, external_order_id: input.externalOrderId, total_amount: Math.round(input.totalAmount),
    payment_status: "paid", fulfillment_status: "procurement_pending", customer_name: input.customerName ?? null,
    shipping_address: input.shippingAddress, raw_payload: input.rawPayload, updated_at: new Date().toISOString()
  }, { onConflict: "channel,external_order_id", ignoreDuplicates: true }).select("id").maybeSingle();
  if (error) throw new Error("order_upsert_failed:" + error.message);
  let orderId: string;
  let duplicate = false;
  if (order) {
    orderId = order.id as string;
  } else {
    const { data: existing, error: lookupError } = await db.from("commerce_orders")
      .select("id,customer_name,shipping_address")
      .eq("channel", input.channel).eq("external_order_id", input.externalOrderId).single();
    if (lookupError || !existing) throw new Error("order_idempotency_lookup_failed:" + (lookupError?.message ?? ""));
    orderId = existing.id as string;
    duplicate = true;
    // Retry intake can repair an incomplete shipping address. Merge only non-empty
    // values and do not reset fulfillment_status or payment_status on duplicate delivery.
    const previousAddress = existing.shipping_address && typeof existing.shipping_address === "object" && !Array.isArray(existing.shipping_address)
      ? existing.shipping_address as Record<string, unknown> : {};
    const refreshedAddress = { ...previousAddress };
    for (const [key, value] of Object.entries(input.shippingAddress)) {
      if (value !== null && value !== undefined && String(value).trim() !== "") refreshedAddress[key] = value;
    }
    const { error: refreshError } = await db.from("commerce_orders").update({
      total_amount: Math.round(input.totalAmount),
      customer_name: input.customerName || existing.customer_name || null,
      shipping_address: refreshedAddress,
      raw_payload: input.rawPayload,
      updated_at: new Date().toISOString(),
    }).eq("id", orderId);
    if (refreshError) throw new Error("order_refresh_failed:" + refreshError.message);
  }
  // Reconcile lines on retries so a prior partial write can be repaired.
  for (const line of input.lines) {
    const { data: savedLine, error: lineError } = await db.from("commerce_order_lines").upsert({
      order_id: orderId, variant_id: line.variantId, external_line_id: line.externalLineId,
      sku: line.sku ?? null, quantity: line.quantity, unit_price: Math.round(line.unitPrice), supplier_offer_id: line.offerId
    }, { onConflict: "order_id,external_line_id" }).select("id").single();
    if (lineError || !savedLine) throw new Error("order_line_upsert_failed:" + (lineError?.message ?? ""));
    if (line.selection && Object.keys(line.selection).length > 0) {
      const { error: selectionError } = await db.from("commerce_order_lines").update({ selection: line.selection }).eq("id", savedLine.id);
      if (selectionError && !/selection/i.test(selectionError.message)) throw new Error("order_line_selection_save_failed:" + selectionError.message);
    }
    const offer = offersById.get(line.offerId);
    if (!offer) throw new Error("order_line_supplier_offer_missing");
    const { error: poError } = await db.from("procurement_orders").upsert({
      order_line_id: savedLine.id, supplier_code: offer.supplier_code,
      supplier_product_id: offer.supplier_product_id, supplier_variant_id: offer.supplier_variant_id,
      quantity: line.quantity, status: "pending"
    }, { onConflict: "order_line_id", ignoreDuplicates: true });
    if (poError) throw new Error("procurement_create_failed:" + poError.message);
  }
  return { orderId, duplicate };
}
