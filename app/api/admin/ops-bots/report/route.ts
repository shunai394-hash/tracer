import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runReadOnlyOperationsBots, type OperationsProductSnapshot, type SalesChannel } from "@/lib/ops-bots/read-only-orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Db = ReturnType<typeof createSupabaseAdminClient>;
type Row = Record<string, unknown>;

async function readAll(db: Db, table: string, columns: string, orderColumn: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; from < 10_000; from += 1000) {
    const { data, error } = await db.from(table).select(columns).order(orderColumn, { ascending: true }).range(from, from + 999);
    if (error) throw new Error(table + "_read_failed");
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
  throw new Error(table + "_read_incomplete");
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function num(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
function iso(value: unknown): string | null {
  const valueString = str(value);
  return valueString && Number.isFinite(Date.parse(valueString)) ? valueString : null;
}

/**
 * Protected read-only shadow report for the operations bots.
 * No external channel APIs, supplier APIs, database writes, or order actions.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const db = createSupabaseAdminClient();
    const [productRows, variantRows, offerRows, priceRows, listingRows] = await Promise.all([
      readAll(db, "commerce_products", "id,title_ja,description_ja,active,updated_at", "id"),
      readAll(db, "commerce_variants", "id,product_id,title_ja,sku,source_variant_key,updated_at", "id"),
      readAll(db, "supplier_offers", "id,variant_id,supplier_product_id,supplier_variant_id,inventory,unit_cost,shipping_cost,ship_to,tracking_supported,source_status,last_checked_at,currency", "id"),
      readAll(db, "commerce_prices", "variant_id,supplier_offer_id,selling_price,expected_profit,margin_rate,currency", "variant_id"),
      readAll(db, "channel_listings", "id,variant_id,channel,external_product_id,external_variant_id,external_sku,selling_price,status,published_url,last_synced_at", "id"),
    ]);

    const productsById = new Map(productRows.map((row) => [str(row.id), row]));
    const offersById = new Map(offerRows.map((row) => [str(row.id), row]));
    const variantsById = new Map(variantRows.map((row) => [str(row.id), row]));
    const listingsByVariant = new Map<string, Row[]>();
    for (const listing of listingRows) {
      const variantId = str(listing.variant_id);
      if (!variantId) continue;
      const current = listingsByVariant.get(variantId) ?? [];
      current.push(listing);
      listingsByVariant.set(variantId, current);
    }

    const priceByVariant = new Map<string, Row[]>();
    for (const price of priceRows) {
      const variantId = str(price.variant_id);
      if (!variantId) continue;
      const current = priceByVariant.get(variantId) ?? [];
      current.push(price);
      priceByVariant.set(variantId, current);
    }

    const now = Date.now();
    const products: OperationsProductSnapshot[] = [];
    let rejectedRows = 0;
    for (const variant of variantRows) {
      const variantId = str(variant.id);
      const productId = str(variant.product_id);
      const product = productId ? productsById.get(productId) : null;
      if (!variantId || !productId || !product) { rejectedRows += 1; continue; }

      const offers = offerRows.filter((offer) => str(offer.variant_id) === variantId);
      const prices = priceByVariant.get(variantId) ?? [];
      const matched = prices
        .map((price) => ({ price, offer: offersById.get(str(price.supplier_offer_id)) }))
        .filter((pair) => pair.offer && str(pair.offer.variant_id) === variantId)
        .sort((a, b) => Number(b.price.selling_price ?? 0) - Number(a.price.selling_price ?? 0))[0];
      const offer = matched?.offer ?? offers[0] ?? null;
      const price = matched?.price ?? null;
      const checkedAt = iso(offer?.last_checked_at);
      const freshOffer = Boolean(
        offer &&
        str(offer.source_status) === "verified" &&
        str(offer.ship_to) === "JP" &&
        str(offer.supplier_product_id) &&
        str(offer.supplier_variant_id) &&
        (num(offer.unit_cost) ?? 0) > 0 &&
        (num(offer.shipping_cost) ?? 0) > 0 &&
        bool(offer.tracking_supported) === true &&
        (num(offer.inventory) ?? 0) > 0 &&
        checkedAt &&
        now - Date.parse(checkedAt) <= 24 * 60 * 60 * 1000
      );
      const sellingPrice = num(price?.selling_price);
      const supplierCost = num(offer?.unit_cost);
      const japanShippingCost = num(offer?.shipping_cost);
      const margin = sellingPrice && supplierCost !== null && japanShippingCost !== null
        ? (sellingPrice - supplierCost - japanShippingCost) / sellingPrice
        : null;
      const eligible = bool(product.active) === true && freshOffer && (sellingPrice ?? 0) > 0 && margin !== null && margin >= 0.5;

      const channels: Partial<Record<SalesChannel, OperationsProductSnapshot["channels"][SalesChannel]>> = {};
      for (const listing of listingsByVariant.get(variantId) ?? []) {
        const channelName = str(listing.channel)?.toLowerCase();
        const channel: SalesChannel | null = channelName === "base" ? "BASE"
          : channelName === "shopify" ? "Shopify"
          : channelName === "newfind" ? "NEWFIND" : null;
        if (!channel) continue;
        channels[channel] = {
          externalProductId: str(listing.external_product_id),
          externalVariantId: str(listing.external_variant_id),
          sku: str(listing.external_sku),
          sellingPrice: num(listing.selling_price),
          // channel_listings does not provide a verified live stock field;
          // keep it unknown rather than assuming it equals TRACER stock.
          stock: null,
          published: str(listing.status) === "published",
          observedAt: iso(listing.last_synced_at),
        };
      }

      products.push({
        tracerProductId: productId,
        supplierProductId: str(offer?.supplier_product_id),
        supplierVariantId: str(offer?.supplier_variant_id),
        sku: str(variant.sku) ?? str(variant.source_variant_key),
        title: str(variant.title_ja) ?? str(product.title_ja),
        description: str(product.description_ja),
        supplierCost,
        japanShippingCost,
        sellingPrice,
        stock: num(offer?.inventory),
        trackingAvailable: bool(offer?.tracking_supported),
        shouldBePublic: eligible,
        updatedAt: checkedAt ?? iso(variant.updated_at) ?? iso(product.updated_at),
        channels,
      });
    }

    const report = runReadOnlyOperationsBots({ products, generatedAt: new Date().toISOString() });
    return NextResponse.json({
      ok: true,
      readOnly: true,
      source: "canonical_commerce_tables",
      channelStockVerification: "not_available_in_channel_listings",
      newfindPriceStockVerification: "requires_supported_live_snapshot",
      rejectedRows,
      report,
    }, {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "read_only_ops_bot_report_failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
