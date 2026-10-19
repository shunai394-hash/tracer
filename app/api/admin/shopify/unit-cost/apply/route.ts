import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isShopifyConfigured, shopifyGraphQL, toShopifyGid } from "@/lib/shopify/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Listing = {
  variant_id: string;
  external_product_id: string | null;
  external_variant_id: string | null;
  external_sku: string | null;
  status: string | null;
};
type Offer = {
  unit_cost?: unknown;
  currency?: unknown;
  shipping_cost?: unknown;
  source_status?: unknown;
  inventory?: unknown;
  supplier_product_id?: unknown;
  supplier_variant_id?: unknown;
  raw_data?: unknown;
};
type Price = {
  currency?: unknown;
  selling_price?: unknown;
  expected_profit?: unknown;
  calculated_at?: unknown;
};
type LiveVariant = {
  id: string;
  sku: string | null;
  inventoryItem: { id: string; unitCost: { amount: string; currencyCode: string } | null } | null;
};
const numeric = (value: unknown): number | null => {
  const n = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(n) ? n : null;
};
const asRows = <T,>(value: T | T[] | null | undefined): T[] =>
  Array.isArray(value) ? value : value ? [value] : [];

export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  const headers = { "Cache-Control": "no-store" };
  if (!isShopifyConfigured()) {
    return NextResponse.json({ ok: false, error: "SHOPIFY_NOT_CONFIGURED" }, { status: 503, headers });
  }

  let body: { confirmApply?: boolean; variantIds?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "INVALID_JSON" }, { status: 400, headers });
  }
  const apply = body.confirmApply === true;
  const requestedIds = body.variantIds === undefined ? null : body.variantIds;
  if (requestedIds !== null && (!Array.isArray(requestedIds) || requestedIds.length > 100 || requestedIds.some((id) => typeof id !== "string" || !id.trim()))) {
    return NextResponse.json({ ok: false, error: "VARIANT_IDS_MUST_BE_AN_ARRAY_OF_AT_MOST_100_NONEMPTY_STRINGS" }, { status: 400, headers });
  }
  if (apply && requestedIds === null) {
    return NextResponse.json({ ok: false, error: "APPLY_REQUIRES_EXPLICIT_VARIANT_IDS", hint: "Run preview first, then pass the exact approved variantIds with confirmApply:true." }, { status: 400, headers });
  }

  const store = await shopifyGraphQL<{ shop: { currencyCode: string } }>("query TracerShopCurrency { shop { currencyCode } }");
  if (store.shop?.currencyCode !== "JPY") {
    return NextResponse.json({ ok: false, error: "SHOPIFY_STORE_CURRENCY_NOT_JPY", storeCurrency: store.shop?.currencyCode ?? null, readOnly: true }, { status: 409, headers });
  }

  const db = createSupabaseAdminClient();
  const listings: Listing[] = [];
  for (let offset = 0; offset < 5000; offset += 1000) {
    const { data, error } = await db.from("channel_listings")
      .select("variant_id,external_product_id,external_variant_id,external_sku,status")
      .eq("channel", "shopify")
      .order("variant_id", { ascending: true })
      .range(offset, offset + 999);
    if (error) return NextResponse.json({ ok: false, error: "SHOPIFY_LISTING_READ_FAILED" }, { status: 502, headers });
    listings.push(...((data ?? []) as Listing[]));
    if ((data ?? []).length < 1000) break;
  }
  const requestedSet = requestedIds ? new Set(requestedIds as string[]) : null;
  const selected = listings.filter((row) => !requestedSet || requestedSet.has(row.variant_id));
  if (requestedSet && selected.length !== requestedSet.size) {
    return NextResponse.json({ ok: false, error: "UNKNOWN_VARIANT_IDS", unknownVariantIds: [...requestedSet].filter((id) => !selected.some((row) => row.variant_id === id)), readOnly: true }, { status: 404, headers });
  }

  const evidence = new Map<string, { supplierProductId: string | null; supplierVariantId: string | null; unitCost: number | null; currency: string | null; shippingKnown: boolean; inventory: number | null; sourceStatus: string | null; sellingPrice: number | null; priceCurrency: string | null; expectedProfit: number | null; reason: string[] }>();
  for (let offset = 0; offset < selected.length; offset += 100) {
    const batch = selected.slice(offset, offset + 100);
    const { data, error } = await db.from("commerce_variants")
      .select("id,supplier_product_id,supplier_variant_id,supplier_offers(unit_cost,currency,shipping_cost,source_status,inventory,supplier_product_id,supplier_variant_id,raw_data),commerce_prices(currency,selling_price,expected_profit,calculated_at)")
      .in("id", batch.map((row) => row.variant_id));
    if (error) return NextResponse.json({ ok: false, error: "SUPPLIER_EVIDENCE_READ_FAILED" }, { status: 502, headers });
    for (const row of data ?? []) {
      const offers = asRows(row.supplier_offers as Offer | Offer[] | null);
      const offer = offers[0];
      const prices = asRows(row.commerce_prices as Price | Price[] | null).sort((a, b) => Date.parse(String(b.calculated_at ?? "")) - Date.parse(String(a.calculated_at ?? "")));
      const price = prices[0];
      const raw = offer?.raw_data && typeof offer.raw_data === "object" && !Array.isArray(offer.raw_data) ? offer.raw_data as Record<string, unknown> : {};
      const unitCost = numeric(offer?.unit_cost);
      const shippingCost = numeric(offer?.shipping_cost);
      const inventory = numeric(offer?.inventory);
      const sellingPrice = numeric(price?.selling_price);
      const expectedProfit = numeric(price?.expected_profit);
      const currency = typeof offer?.currency === "string" ? offer.currency.toUpperCase() : null;
      const priceCurrency = typeof price?.currency === "string" ? price.currency.toUpperCase() : null;
      const sourceStatus = typeof offer?.source_status === "string" ? offer.source_status : null;
      const supplierProductId = typeof row.supplier_product_id === "string" ? row.supplier_product_id : typeof offer?.supplier_product_id === "string" ? offer.supplier_product_id : null;
      const supplierVariantId = typeof row.supplier_variant_id === "string" ? row.supplier_variant_id : typeof offer?.supplier_variant_id === "string" ? offer.supplier_variant_id : null;
      const shippingKnown = raw.shippingKnown === true || (raw.shippingKnown === undefined && raw.shippingEstimated !== true && sourceStatus === "verified" && (shippingCost ?? 0) > 0);
      const reason: string[] = [];
      if (!supplierProductId || !supplierVariantId) reason.push("supplier_identity_missing");
      if (sourceStatus !== "verified") reason.push("supplier_offer_not_verified");
      if (currency !== "JPY" || unitCost === null || unitCost <= 0) reason.push("supplier_unit_cost_not_verified_jpy");
      if (!shippingKnown || shippingCost === null || shippingCost < 0) reason.push("japan_shipping_unconfirmed");
      if (inventory === null || inventory <= 0) reason.push("supplier_inventory_not_positive");
      if (priceCurrency !== "JPY" || sellingPrice === null || sellingPrice <= 0) reason.push("selling_price_not_verified_jpy");
      if (expectedProfit === null || expectedProfit <= 0) reason.push("expected_profit_not_positive");
      evidence.set(String(row.id), { supplierProductId, supplierVariantId, unitCost, currency, shippingKnown, inventory, sourceStatus, sellingPrice, priceCurrency, expectedProfit, reason });
    }
  }

  const liveById = new Map<string, LiveVariant>();
  const readable = selected.filter((row) => toShopifyGid("ProductVariant", row.external_variant_id));
  for (let offset = 0; offset < readable.length; offset += 50) {
    const ids = readable.slice(offset, offset + 50).map((row) => toShopifyGid("ProductVariant", row.external_variant_id)).filter((id): id is string => Boolean(id));
    const data = await shopifyGraphQL<{ nodes: Array<LiveVariant | null> }>(
      `query TracerUnitCostApplyPreflight($ids: [ID!]!) {
        nodes(ids: $ids) { ... on ProductVariant { id sku inventoryItem { id unitCost { amount currencyCode } } } }
      }`,
      { ids },
    );
    for (const node of data.nodes ?? []) if (node?.id) liveById.set(node.id, node);
  }

  const items = selected.map((listing) => {
    const gid = toShopifyGid("ProductVariant", listing.external_variant_id);
    const live = gid ? liveById.get(gid) : null;
    const ev = evidence.get(listing.variant_id);
    const reasons = [...(ev?.reason ?? ["supplier_evidence_missing"])];
    if (!gid || !live?.inventoryItem?.id) reasons.push("shopify_variant_or_inventory_item_missing");
    if (live && live.sku !== listing.external_sku) reasons.push("shopify_sku_mismatch");
    return { variantId: listing.variant_id, externalVariantId: gid, sku: listing.external_sku, liveSku: live?.sku ?? null, currentCost: live?.inventoryItem?.unitCost?.amount ?? null, currentCurrency: live?.inventoryItem?.unitCost?.currencyCode ?? null, supplierUnitCost: ev?.unitCost ?? null, supplierCurrency: ev?.currency ?? null, expectedProfit: ev?.expectedProfit ?? null, eligible: reasons.length === 0, reasons };
  });
  const eligible = items.filter((item) => item.eligible);
  if (!apply) {
    return NextResponse.json({ ok: true, readOnly: true, applyRequired: true, storeCurrency: store.shop.currencyCode, selected: selected.length, eligible: eligible.length, blocked: items.length - eligible.length, items }, { headers });
  }

  const applied: Array<{ variantId: string; externalVariantId: string; expectedCost: number; readBackCost: number | null; verified: boolean; error?: string }> = [];
  for (const item of eligible) {
    const ev = evidence.get(item.variantId)!;
    const live = liveById.get(item.externalVariantId)!;
    try {
      const result = await shopifyGraphQL<{ inventoryItemUpdate: { inventoryItem: { id: string; unitCost: { amount: string; currencyCode: string } | null } | null; userErrors: Array<{ message: string }> }>(
        `mutation TracerSetVerifiedInventoryItemCost($id: ID!, $input: InventoryItemInput!) {
          inventoryItemUpdate(id: $id, input: $input) { inventoryItem { id unitCost { amount currencyCode } } userErrors { message } }
        }`,
        { id: live.inventoryItem.id, input: { cost: ev.unitCost } },
      );
      if (result.inventoryItemUpdate.userErrors.length || !result.inventoryItemUpdate.inventoryItem) {
        throw new Error(result.inventoryItemUpdate.userErrors.map((e) => e.message).join("; ") || "SHOPIFY_COST_UPDATE_RETURNED_NO_ITEM");
      }
      const readback = await shopifyGraphQL<{ node: { ... } | null }>("query { node(id: \"" + live.inventoryItem.id + "\") { id } }").catch(() => null);
      const amount = numeric(result.inventoryItemUpdate.inventoryItem.unitCost?.amount);
      const currency = result.inventoryItemUpdate.inventoryItem.unitCost?.currencyCode ?? null;
      applied.push({ variantId: item.variantId, externalVariantId: item.externalVariantId, expectedCost: ev.unitCost!, readBackCost: amount, verified: amount === ev.unitCost && currency === "JPY" });
    } catch (error) {
      applied.push({ variantId: item.variantId, externalVariantId: item.externalVariantId, expectedCost: ev.unitCost!, readBackCost: null, verified: false, error: error instanceof Error ? error.message.slice(0, 200) : "SHOPIFY_COST_UPDATE_FAILED" });
    }
  }
  return NextResponse.json({ ok: applied.every((item) => item.verified), readOnly: false, applied: applied.length, verified: applied.filter((item) => item.verified).length, failed: applied.filter((item) => !item.verified).length, storeCurrency: store.shop.currencyCode, items: applied }, { status: applied.every((item) => item.verified) ? 200 : 207, headers });
}
