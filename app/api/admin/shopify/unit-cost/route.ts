import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isShopifyConfigured, shopifyGraphQL, toShopifyGid } from "@/lib/shopify/admin";
import { judgeUnitCost } from "@/lib/shopify/unit-cost-reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Listing = {
  variant_id: string;
  external_product_id: string | null;
  external_variant_id: string | null;
  external_sku: string | null;
  selling_price: number | null;
  status: string | null;
};

type ShopifyVariant = {
  id: string;
  sku: string | null;
  price: string | null;
  inventoryItem: { unitCost: { amount: string; currencyCode: string } | null } | null;
};

function money(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  const headers = { "Cache-Control": "no-store" };
  if (!isShopifyConfigured()) {
    return NextResponse.json({ ok: false, error: "SHOPIFY_NOT_CONFIGURED" }, { status: 503, headers });
  }

  const db = createSupabaseAdminClient();
  const listings: Listing[] = [];
  for (let offset = 0; offset < 5_000; offset += 1000) {
    const { data, error } = await db.from("channel_listings")
      .select("variant_id,external_product_id,external_variant_id,external_sku,selling_price,status")
      .eq("channel", "shopify")
      .order("variant_id", { ascending: true })
      .range(offset, offset + 999);
    if (error) return NextResponse.json({ ok: false, error: "SHOPIFY_LISTING_READ_FAILED" }, { status: 502, headers });
    listings.push(...((data ?? []) as Listing[]));
    if ((data ?? []).length < 1000) break;
  }

  const offersByVariant = new Map<string, { unitCost: number | null; currency: string | null; shippingCost: number | null; shippingKnown: boolean }>();
  const pricesByVariant = new Map<string, { currency: string | null; sellingPrice: number | null; expectedProfit: number | null }>();
  for (let offset = 0; offset < listings.length; offset += 100) {
    const ids = listings.slice(offset, offset + 100).map((row) => row.variant_id);
    const { data, error } = await db.from("commerce_variants")
      .select("id,supplier_offers(unit_cost,currency,shipping_cost,raw_data,source_status),commerce_prices(currency,selling_price,expected_profit,calculated_at)")
      .in("id", ids);
    if (error) return NextResponse.json({ ok: false, error: "SUPPLIER_COST_READ_FAILED" }, { status: 502, headers });
    for (const row of data ?? []) {
      const variantId = String(row.id);
      const offerRows = Array.isArray(row.supplier_offers) ? row.supplier_offers : row.supplier_offers ? [row.supplier_offers] : [];
      const offer = offerRows[0] as { unit_cost?: unknown; currency?: unknown; shipping_cost?: unknown; raw_data?: unknown; source_status?: unknown } | undefined;
      const raw = offer?.raw_data && typeof offer.raw_data === "object" && !Array.isArray(offer.raw_data)
        ? offer.raw_data as Record<string, unknown> : {};
      const shippingKnown = raw.shippingKnown === true ||
        (raw.shippingKnown === undefined && raw.shippingEstimated !== true && offer?.source_status === "verified" && Number(offer?.shipping_cost) > 0);
      offersByVariant.set(variantId, {
        unitCost: money(offer?.unit_cost),
        currency: typeof offer?.currency === "string" ? offer.currency : null,
        shippingCost: money(offer?.shipping_cost),
        shippingKnown,
      });
      const priceRows = Array.isArray(row.commerce_prices) ? row.commerce_prices : row.commerce_prices ? [row.commerce_prices] : [];
      const price = [...priceRows].sort((a, b) => Date.parse(String((b as { calculated_at?: string }).calculated_at ?? "")) - Date.parse(String((a as { calculated_at?: string }).calculated_at ?? "")))[0] as { currency?: unknown; selling_price?: unknown; expected_profit?: unknown } | undefined;
      pricesByVariant.set(variantId, {
        currency: typeof price?.currency === "string" ? price.currency : null,
        sellingPrice: money(price?.selling_price),
        expectedProfit: money(price?.expected_profit),
      });
    }
  }

  const shopifyCost = new Map<string, { amount: number | null; currency: string | null; error: string | null }>();
  let accessDenied: string | null = null;
  const readable = listings.filter((row) => toShopifyGid("ProductVariant", row.external_variant_id));
  for (let offset = 0; offset < readable.length && !accessDenied; offset += 50) {
    const batch = readable.slice(offset, offset + 50);
    const ids = batch.map((row) => toShopifyGid("ProductVariant", row.external_variant_id)).filter((id): id is string => Boolean(id));
    try {
      const data = await shopifyGraphQL<{ nodes: Array<ShopifyVariant | null> }>(
        `query TracerVariantUnitCost($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant { id sku price inventoryItem { unitCost { amount currencyCode } } }
          }
        }`,
        { ids },
      );
      for (const node of data.nodes ?? []) {
        if (!node?.id) continue;
        const amount = money(node.inventoryItem?.unitCost?.amount);
        shopifyCost.set(node.id, {
          amount,
          currency: node.inventoryItem?.unitCost?.currencyCode ?? null,
          error: node.inventoryItem?.unitCost ? null : "shopify_unit_cost_missing",
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "shopify_unit_cost_read_failed";
      accessDenied = /HTTP 403|access denied|ACCESS_DENIED/i.test(message) ? "shopify_unit_cost_access_denied" : message.slice(0, 180);
    }
  }

  const runId = `shopify-unit-cost-${new Date().toISOString()}-${crypto.randomUUID()}`;
  const observedAt = new Date().toISOString();
  const items = listings.map((listing) => {
    const gid = toShopifyGid("ProductVariant", listing.external_variant_id);
    const live = gid ? shopifyCost.get(gid) : null;
    const offer = offersByVariant.get(listing.variant_id);
    const price = pricesByVariant.get(listing.variant_id);
    const verdict = judgeUnitCost({
      shopifyUnitCost: accessDenied ? null : live?.amount ?? null,
      shopifyCurrency: live?.currency ?? null,
      supplierUnitCost: offer?.unitCost ?? null,
      supplierCurrency: offer?.currency ?? null,
      shippingCost: offer?.shippingCost ?? null,
      shippingKnown: offer?.shippingKnown === true,
      sellingPrice: price?.sellingPrice ?? (listing.selling_price == null ? null : Number(listing.selling_price)),
      expectedProfit: price?.expectedProfit ?? null,
      priceCurrency: price?.currency ?? null,
    });
    if (accessDenied) verdict.reasons.unshift(accessDenied);
    if (!gid) verdict.reasons.unshift("shopify_variant_id_missing");
    return {
      variantId: listing.variant_id,
      externalProductId: listing.external_product_id,
      externalVariantId: listing.external_variant_id,
      sku: listing.external_sku,
      dbStatus: listing.status,
      shopifyUnitCost: live?.amount ?? null,
      shopifyCurrency: live?.currency ?? null,
      supplierUnitCost: offer?.unitCost ?? null,
      shippingCost: offer?.shippingCost ?? null,
      sellingPrice: price?.sellingPrice ?? null,
      expectedProfit: price?.expectedProfit ?? null,
      ...verdict,
      profitConfirmed: accessDenied ? false : verdict.profitConfirmed,
      costConfirmed: accessDenied ? false : verdict.costConfirmed,
    };
  });

  const rows = items.map((item) => ({
    run_id: runId,
    channel: "shopify",
    external_product_id: item.externalVariantId ?? `missing:${item.variantId}`,
    external_variant_id: item.externalVariantId,
    variant_id: item.variantId,
    external_sku: item.sku,
    internal_sku: item.sku,
    external_price: item.shopifyUnitCost,
    canonical_price: item.supplierUnitCost,
    db_channel_price: item.sellingPrice,
    product_status: item.profitConfirmed ? "profit_confirmed" : "profit_unconfirmed",
    price_matches: item.costConfirmed,
    sku_matches: null,
    observed_at: observedAt,
    details: {
      source: "shopify_inventory_item_unit_cost",
      productId: item.externalProductId,
      shippingCost: item.shippingCost,
      expectedProfit: item.expectedProfit,
      costConfirmed: item.costConfirmed,
      profitConfirmed: item.profitConfirmed,
      reasons: item.reasons,
      accessDenied,
    },
  }));
  let written = 0;
  let writeError: string | null = null;
  for (let offset = 0; offset < rows.length; offset += 100) {
    const { error } = await db.from("channel_price_reconciliation_audit").insert(rows.slice(offset, offset + 100));
    if (error) {
      writeError = error.code ?? "audit_write_failed";
      break;
    }
    written += Math.min(100, rows.length - offset);
  }

  const summary = {
    listings: items.length,
    shopifyCostRead: items.filter((item) => item.shopifyUnitCost !== null).length,
    costConfirmed: items.filter((item) => item.costConfirmed).length,
    profitConfirmed: items.filter((item) => item.profitConfirmed).length,
    shopifyUnitCostMissing: items.filter((item) => item.reasons.includes("shopify_unit_cost_missing")).length,
    supplierUnitCostMissing: items.filter((item) => item.reasons.includes("supplier_unit_cost_missing")).length,
    domesticShippingUnconfirmed: items.filter((item) => item.reasons.includes("domestic_shipping_unconfirmed")).length,
    accessDenied,
    auditRowsWritten: written,
    auditWriteError: writeError,
  };
  return NextResponse.json({
    ok: accessDenied === null && writeError === null,
    readOnly: true,
    runId,
    ...summary,
    items,
  }, { status: accessDenied || writeError ? 207 : 200, headers });
}
