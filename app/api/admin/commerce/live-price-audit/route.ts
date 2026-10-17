import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { fetchBaseItemsSnapshot } from "@/lib/channels/base";
import { getOnlineStorePublicationId, isShopifyConfigured, shopifyGraphQL } from "@/lib/shopify/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type ChannelListing = {
  id: string;
  channel: string;
  variant_id: string;
  external_product_id: string | null;
  external_variant_id: string | null;
  external_sku: string | null;
  selling_price: number | string | null;
  status: string | null;
};

type ShopifyPage = {
  products: {
    nodes: Array<{
      id: string;
      title: string;
      status: string;
      publishedOnPublication: boolean;
      totalInventory: number;
      variants: { nodes: Array<{ id: string; sku: string | null; price: string | null }> };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

function norm(value: unknown): string {
  return String(value ?? "").trim();
}

function yen(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * Read-only audit of actual BASE/Shopify prices against TRACER's latest
 * commerce_prices. It intentionally performs no external updates and never
 * maps by title; SKU and recorded external IDs are the only matching evidence.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const db = createSupabaseAdminClient();
    const listings: ChannelListing[] = [];
    for (let offset = 0; ; offset += 1000) {
      if (offset >= 50_000) {
        return NextResponse.json({ ok: false, complete: false, error: "TRACER_CHANNEL_SCAN_LIMIT_REACHED" }, { status: 503 });
      }
      const { data, error } = await db.from("channel_listings")
        .select("id,channel,variant_id,external_product_id,external_variant_id,external_sku,selling_price,status")
        .in("channel", ["base", "shopify"])
        .order("id", { ascending: true })
        .range(offset, offset + 999);
      if (error) throw new Error("TRACER_CHANNEL_LISTINGS_READ_FAILED");
      listings.push(...((data ?? []) as ChannelListing[]));
      if ((data ?? []).length < 1000) break;
    }

    const variantIds = [...new Set(listings.map((row) => norm(row.variant_id)).filter(Boolean))];
    const prices: Array<{ variant_id: string; selling_price: number | string | null; calculated_at: string | null }> = [];
    for (let offset = 0; offset < variantIds.length; offset += 100) {
      const { data, error } = await db.from("commerce_prices")
        .select("variant_id,selling_price,calculated_at")
        .in("variant_id", variantIds.slice(offset, offset + 100))
        .order("calculated_at", { ascending: false, nullsFirst: false });
      if (error) throw new Error("TRACER_CANONICAL_PRICES_READ_FAILED");
      prices.push(...((data ?? []) as typeof prices));
    }
    const canonicalPrice = new Map<string, number | null>();
    for (const price of prices) {
      if (!canonicalPrice.has(String(price.variant_id))) canonicalPrice.set(String(price.variant_id), yen(price.selling_price));
    }

    const baseSnapshot = await fetchBaseItemsSnapshot({ itemPageLimit: 100 });
    if (!baseSnapshot.complete) throw new Error("BASE_SNAPSHOT_INCOMPLETE");
    const baseById = new Map<string, Record<string, unknown>>();
    for (const item of baseSnapshot.items) baseById.set(norm(item.item_id), item);

    const shopifyBySku = new Map<string, Array<{ productId: string; variantId: string; title: string; status: string; published: boolean; totalInventory: number; price: number | null }>>();
    let after: string | undefined;
    let shopifyPages = 0;
    let shopifyComplete = false;
    const needsShopify = listings.some((listing) => listing.channel === "shopify");
    if (needsShopify && !isShopifyConfigured()) throw new Error("SHOPIFY_NOT_CONFIGURED_FOR_LIVE_AUDIT");
    if (needsShopify) {
      const onlineStorePublicationId = await getOnlineStorePublicationId();
      for (let page = 0; page < 200; page += 1) {
        const result = await shopifyGraphQL<ShopifyPage>(
          "query LivePriceAudit($first: Int!, $after: String, $publicationId: ID!) { products(first: $first, after: $after) { nodes { id title status publishedOnPublication(publicationId: $publicationId) totalInventory variants(first: 100) { nodes { id sku price } } } pageInfo { hasNextPage endCursor } } }",
          { first: 50, after: after ?? null, publicationId: onlineStorePublicationId },
        );
        shopifyPages += 1;
        for (const product of result.products.nodes) {
          for (const variant of product.variants.nodes) {
            const sku = norm(variant.sku);
            if (!sku) continue;
            const group = shopifyBySku.get(sku) ?? [];
            group.push({ productId: product.id, variantId: variant.id, title: product.title, status: product.status, published: product.publishedOnPublication, totalInventory: product.totalInventory, price: yen(variant.price) });
            shopifyBySku.set(sku, group);
          }
        }
        if (!result.products.pageInfo.hasNextPage) {
          shopifyComplete = true;
          break;
        }
        if (!result.products.pageInfo.endCursor) throw new Error("SHOPIFY_PAGINATION_CURSOR_MISSING");
        after = result.products.pageInfo.endCursor;
      }
      if (!shopifyComplete) throw new Error("SHOPIFY_PRODUCT_SCAN_INCOMPLETE");
    }

    const discrepancies: Array<Record<string, unknown>> = [];
    const summary = {
      baseItemsScanned: baseSnapshot.items.length,
      shopifyPagesScanned: shopifyPages,
      shopifySkuCount: shopifyBySku.size,
      tracerListingsScanned: listings.length,
      baseListingsChecked: 0,
      shopifyListingsChecked: 0,
      priceMismatches: 0,
      missingExternalItems: 0,
      ambiguousSkuMatches: 0,
      missingCanonicalPrice: 0,
      duplicateLiveSku: 0,
    };

    for (const listing of listings) {
      const sku = norm(listing.external_sku);
      const expected = canonicalPrice.get(String(listing.variant_id));
      if (expected == null) {
        summary.missingCanonicalPrice += 1;
        discrepancies.push({ channel: listing.channel, listingId: listing.id, variantId: listing.variant_id, sku, issue: "canonical_price_missing" });
        continue;
      }
      if (listing.channel === "base") {
        summary.baseListingsChecked += 1;
        const item = baseById.get(norm(listing.external_product_id));
        if (!item) {
          summary.missingExternalItems += 1;
          discrepancies.push({ channel: "base", listingId: listing.id, externalProductId: listing.external_product_id, sku, expectedPrice: expected, issue: "external_item_missing" });
          continue;
        }
        const actual = yen(item.price);
        const identifier = norm(item.identifier);
        const identifierMismatch = Boolean(sku && identifier && sku !== identifier);
        const visibilityMismatch = (listing.status === "published" && item.visible === false) || (listing.status !== "published" && item.visible === true);
        if (actual !== expected || identifierMismatch || visibilityMismatch) {
          summary.priceMismatches += actual !== expected ? 1 : 0;
          discrepancies.push({ channel: "base", listingId: listing.id, externalProductId: listing.external_product_id, sku, actualIdentifier: identifier || null, expectedPrice: expected, actualPrice: actual, visible: item.visible ?? null, issue: actual !== expected ? "live_price_mismatch" : identifierMismatch ? "identifier_mismatch" : "publication_state_mismatch" });
        }
      } else if (listing.channel === "shopify") {
        summary.shopifyListingsChecked += 1;
        const matches = shopifyBySku.get(sku) ?? [];
        if (matches.length === 0) {
          summary.missingExternalItems += 1;
          discrepancies.push({ channel: "shopify", listingId: listing.id, externalProductId: listing.external_product_id, externalVariantId: listing.external_variant_id, sku, expectedPrice: expected, issue: "external_sku_missing" });
          continue;
        }
        if (matches.length > 1) {
          summary.ambiguousSkuMatches += 1;
          summary.duplicateLiveSku += 1;
          discrepancies.push({ channel: "shopify", listingId: listing.id, sku, expectedPrice: expected, liveMatches: matches, issue: "ambiguous_live_sku_no_mutation" });
          continue;
        }
        const actual = matches[0].price;
        const externalIdMismatch = Boolean((listing.external_product_id && matches[0].productId !== listing.external_product_id) || (listing.external_variant_id && matches[0].variantId !== listing.external_variant_id));
        const availabilityMismatch = matches[0].status !== "ACTIVE" || !matches[0].published || matches[0].totalInventory <= 0;
        if (actual !== expected || externalIdMismatch || availabilityMismatch) {
          summary.priceMismatches += actual !== expected ? 1 : 0;
          discrepancies.push({ channel: "shopify", listingId: listing.id, sku, expectedPrice: expected, actualPrice: actual, recordedProductId: listing.external_product_id, liveProductId: matches[0].productId, recordedVariantId: listing.external_variant_id, liveVariantId: matches[0].variantId, status: matches[0].status, publishedOnOnlineStore: matches[0].published, totalInventory: matches[0].totalInventory, issue: actual !== expected ? "live_price_mismatch" : externalIdMismatch ? "external_id_mismatch" : "publication_or_inventory_mismatch" });
        }
      }
    }

    return NextResponse.json({
      ok: discrepancies.length === 0,
      readOnly: true,
      complete: baseSnapshot.complete && (!needsShopify || shopifyComplete),
      generatedAt: new Date().toISOString(),
      summary,
      discrepancies: discrepancies.slice(0, 500),
      discrepanciesTruncated: discrepancies.length > 500,
      note: "This endpoint only reads external storefront state and TRACER records. It does not change prices, publish/unpublish products, remap identifiers, or delete duplicates.",
    }, { status: discrepancies.length === 0 ? 200 : 207, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "LIVE_PRICE_AUDIT_FAILED";
    console.error("[TRACER LIVE PRICE AUDIT]", { error: message.slice(0, 180) });
    return NextResponse.json({ ok: false, readOnly: true, complete: false, error: message.slice(0, 180) }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
