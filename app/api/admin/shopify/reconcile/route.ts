import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOnlineStorePublicationId, shopifyGraphQL } from "@/lib/shopify/admin";
import { getStorefrontStockCap, toStorefrontStockQuantity } from "@/lib/shopify/storefront-stock";
import { nextShopifyVendorPage, SHOPIFY_VENDOR_SCAN_MAX_PAGES } from "@/lib/shopify/catalog-scan";
import { reconcileShopifyCatalog, type CommerceShopifyRow } from "@/lib/shopify/catalog-reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type ShopifyNode = {
  id: string;
  handle: string;
  status: string;
  vendor: string | null;
  publishedOnPublication: boolean;
  totalInventory: number | null;
  variants: {
    nodes: Array<{ id: string; sku: string | null; price: string | null; inventoryQuantity: number | null }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
  featuredMedia: { id: string } | null;
};

/**
 * Read-only reconciliation of what Shopify actually holds against
 * shop_listings: Shopify status and Online Store publication per TRACER
 * product, and per-row SKU / variant / price / inventory agreement. A DB
 * "published" flag is never taken as proof of Shopify publication.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const publicationId = await getOnlineStorePublicationId();
    // Scan the whole store (vendor TRACER is a subset of it), so the store,
    // vendor and DB populations come from one complete, paginated read.
    const storeNodes: ShopifyNode[] = [];
    let after: string | null = null;
    let vendorPages = 0;
    let vendorScanComplete = false;
    let vendorScanStop: "complete" | "page_cap" | "cursor_stuck" = "page_cap";
    for (let page = 0; page < SHOPIFY_VENDOR_SCAN_MAX_PAGES; page += 1) {
      let data: { products: { nodes: ShopifyNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null = null;
      for (let attempt = 0; !data; attempt += 1) {
        try {
          data = await shopifyGraphQL(
            `query TracerStoreProducts($after: String, $publicationId: ID!) {
              products(first: 100, after: $after, sortKey: ID) {
                nodes {
                  id handle status vendor totalInventory
                  publishedOnPublication(publicationId: $publicationId)
                  featuredMedia { id }
                  variants(first: 100) { nodes { id sku price inventoryQuantity } pageInfo { hasNextPage endCursor } }
                }
                pageInfo { hasNextPage endCursor }
              }
            }`,
            { after, publicationId },
          );
        } catch (error) {
          // Throttling is a rate limit, not a failed scan: wait and retry the same page.
          if (attempt >= 5 || !/throttl/i.test(error instanceof Error ? error.message : String(error))) throw error;
          await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
        }
      }
      storeNodes.push(...data.products.nodes);
      vendorPages += 1;
      const step = nextShopifyVendorPage({
        pageIndex: page,
        maxPages: SHOPIFY_VENDOR_SCAN_MAX_PAGES,
        hasNextPage: data.products.pageInfo.hasNextPage,
        endCursor: data.products.pageInfo.endCursor,
        previousCursor: after,
      });
      if (step.action === "continue") {
        after = step.cursor;
        continue;
      }
      vendorScanComplete = step.action === "complete";
      vendorScanStop = step.action === "complete" ? "complete" : step.reason;
      break;
    }
    const shopify = storeNodes.filter((node) => node.vendor === "TRACER");

    const storeCounts = await shopifyGraphQL<{
      productsCount: { count: number; precision: "EXACT" | "AT_LEAST" };
      activeProductsCount: { count: number; precision: "EXACT" | "AT_LEAST" };
    }>(`query TracerStoreCounts {
      productsCount(limit: 10000) { count precision }
      activeProductsCount: productsCount(query: "status:active", limit: 10000) { count precision }
    }`);
    const handleCollisionSku = "TRC-3CE7D60EDC484EAE9D5E485A";
    let skuNodes: Array<{ id: string; sku: string | null; product: { id: string; handle: string } | null }> = [];
    let skuRecoveryError: string | null = null;
    try {
      const skuRecovery = await shopifyGraphQL<{
        productVariants: { nodes: Array<{ id: string; sku: string | null; product: { id: string; handle: string } | null }> };
      }>(`query TracerSkuRecovery($query: String!) {
        productVariants(first: 5, query: $query) { nodes { id sku product { id handle } } }
      }`, { query: "sku:" + handleCollisionSku });
      skuNodes = skuRecovery.productVariants.nodes.filter((node) => node.sku === handleCollisionSku);
    } catch (error) {
      skuRecoveryError = error instanceof Error ? error.message.split("\n")[0].slice(0, 180) : "sku_lookup_failed";
    }

    const db = createSupabaseAdminClient();
    const { data: rows, error } = await db
      .from("shop_listings")
      .select("id, published, pipeline_reason, selection_reasons, selling_price, inventory, orderable, tracking_available, supplier_name, supplier_product_id, supplier_variant_id, shopify_product_id, shopify_variant_id, shopify_sync_status")
      .not("shopify_product_id", "is", null)
      .limit(10000);
    if (error) throw new Error(error.message);

    // Legacy rows may hold numeric REST ids; compare on the numeric tail.
    const tail = (id: unknown) => String(id ?? "").split("/").pop() ?? "";
    const byId = new Map(shopify.map((node) => [tail(node.id), node]));
    const linkedIds = new Set((rows ?? []).map((row) => tail(row.shopify_product_id)));
    const commerceRows: Array<CommerceShopifyRow & { id: string }> = [];
    for (let from = 0; ; from += 1000) {
      if (from >= 50_000) throw new Error("commerce_channel_scan_incomplete");
      const { data: page, error: commerceError } = await db.from("channel_listings")
        .select("id,variant_id,external_product_id,external_variant_id,external_sku,status,selling_price")
        .eq("channel", "shopify")
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (commerceError) throw new Error(commerceError.message);
      commerceRows.push(...((page ?? []) as Array<CommerceShopifyRow & { id: string }>));
      if ((page ?? []).length < 1000) break;
    }
    const commerceIds = new Set(commerceRows.map((row) => tail(row.external_product_id)).filter(Boolean));
    const catalog = reconcileShopifyCatalog({
      nodes: storeNodes.map((node) => ({ ...node, variants: node.variants.nodes })),
      scanComplete: vendorScanComplete,
      commerceRows,
      legacyRows: (rows ?? []).map((row) => ({ id: String(row.id), shopify_product_id: row.shopify_product_id == null ? null : String(row.shopify_product_id) })),
      probeVariantIds: ["3ce7d60e-dc48-4eae-9d5e-485a7348d1d4", ...new URL(request.url).searchParams.getAll("variant")]
        .filter((id, index, all) => /^[0-9a-f-]{36}$/i.test(id) && all.indexOf(id) === index).slice(0, 20),
    });
    const checks = (rows ?? []).map((row) => {
      const node = byId.get(tail(row.shopify_product_id));
      const variant = node?.variants.nodes.find((v) => tail(v.id) === tail(row.shopify_variant_id))
        ?? (!row.shopify_variant_id ? node?.variants.nodes[0] : undefined);
      const expectedSku = `TRC-${row.id}`.slice(0, 100);
      const gate = Array.isArray(row.selection_reasons) && row.selection_reasons.map(String).includes("sales_test_gate_passed");
      const expectedStorefrontInventory = toStorefrontStockQuantity(row.inventory, getStorefrontStockCap());
      const actualLive = node?.status === "ACTIVE" && node?.publishedOnPublication === true;
      const expectedLive = row.published === true && gate && row.orderable === true && row.tracking_available === true
        && Number(row.inventory) > 0 && Number(row.selling_price) > 0;
      return {
        listingId: String(row.id),
        existsInShopify: Boolean(node),
        shopifyProductId: node?.id ?? null,
        dbShopifyProductId: row.shopify_product_id ?? null,
        shopifyHandle: node?.handle ?? null,
        shopifyStatus: node?.status ?? null,
        publishedOnOnlineStore: node?.publishedOnPublication ?? null,
        dbPublished: row.published === true,
        expectedLive,
        publicationMatches: node ? actualLive === expectedLive : null,
        gatePassed: gate,
        expectedSku,
        shopifySku: variant?.sku ?? null,
        skuMatches: variant ? variant.sku === expectedSku : null,
        dbShopifyVariantId: row.shopify_variant_id ?? null,
        shopifyVariantId: variant?.id ?? null,
        variantScanComplete: node ? !node.variants.pageInfo.hasNextPage : null,
        variantIdMatches: variant ? !row.shopify_variant_id || tail(variant.id) === tail(row.shopify_variant_id)
          : node ? (node.variants.pageInfo.hasNextPage ? null : false) : null,
        legacyNumericId: /^\d+$/.test(String(row.shopify_product_id ?? "")),
        dbSellingPrice: row.selling_price,
        shopifyPrice: variant?.price ?? null,
        priceMatches: variant ? Number(variant.price) === Number(row.selling_price) : null,
        inventoryMatches: variant && variant.inventoryQuantity !== null
          ? Number(variant.inventoryQuantity) === expectedStorefrontInventory
          : null,
        shopifyInventory: variant?.inventoryQuantity ?? null,
        dbInventory: row.inventory,
        expectedStorefrontInventory,
        hasImage: Boolean(node?.featuredMedia),
        supplierVariantId: row.supplier_variant_id ?? null,
        syncStatus: row.shopify_sync_status ?? null,
      };
    });

    const count = (predicate: (c: (typeof checks)[number]) => boolean) => checks.filter(predicate).length;
    const vendorPrecision = vendorScanComplete ? "EXACT" : "AT_LEAST";
    return NextResponse.json({
      ok: vendorScanComplete && storeCounts.productsCount.precision === "EXACT" && storeCounts.activeProductsCount.precision === "EXACT",
      generatedAt: new Date().toISOString(),
      catalog,
      shopifyStore: {
        scope: "all_products",
        totalProducts: storeCounts.productsCount.count,
        activeProducts: storeCounts.activeProductsCount.count,
        countPrecision: storeCounts.productsCount.precision,
        activeCountPrecision: storeCounts.activeProductsCount.precision,
      },
      shopify: {
        scope: "vendor:TRACER",
        scanComplete: vendorScanComplete,
        scanStop: vendorScanStop,
        pages: vendorPages,
        pageCap: SHOPIFY_VENDOR_SCAN_MAX_PAGES,
        countPrecision: vendorPrecision,
        tracerProducts: shopify.length,
        active: shopify.filter((n) => n.status === "ACTIVE").length,
        publishedOnOnlineStore: shopify.filter((n) => n.publishedOnPublication).length,
        activeAndPublished: shopify.filter((n) => n.status === "ACTIVE" && n.publishedOnPublication).length,
        withoutImage: shopify.filter((n) => !n.featuredMedia).length,
        notLinkedInDb: shopify.filter((n) => !linkedIds.has(tail(n.id))).length,
        notLinkedToLegacyShopListings: shopify.filter((n) => !linkedIds.has(tail(n.id))).length,
        matchedToCommerceChannelListings: shopify.filter((n) => commerceIds.has(tail(n.id))).length,
        notLinkedToCommerceChannelListings: shopify.filter((n) => !commerceIds.has(tail(n.id))).length,
      },
      skuRecovery: {
        variantId: "3ce7d60e-dc48-4eae-9d5e-485a7348d1d4",
        sku: handleCollisionSku,
        matches: skuNodes.length,
        ambiguous: skuNodes.length > 1,
        productId: skuNodes.length === 1 ? skuNodes[0].product?.id ?? null : null,
        shopifyVariantId: skuNodes.length === 1 ? skuNodes[0].id : null,
        handle: skuNodes.length === 1 ? skuNodes[0].product?.handle ?? null : null,
        error: skuRecoveryError,
      },
      commerceChannelListings: {
        rows: commerceRows.length,
        published: commerceRows.filter((row) => row.status === "published").length,
        withExternalProductId: commerceRows.filter((row) => row.external_product_id).length,
      },
      // Full row-level evidence is returned to the authenticated audit workflow for artifact export.
      items: checks,
      unlinkedProducts: shopify.filter((node) => !linkedIds.has(tail(node.id))).map((node) => ({
        shopifyProductId: node.id,
        handle: node.handle,
        status: node.status,
        publishedOnOnlineStore: node.publishedOnPublication,
        vendor: node.vendor,
        totalInventory: node.totalInventory,
        variantScanComplete: !node.variants.pageInfo.hasNextPage,
        variants: node.variants.nodes.map((variant) => ({
          shopifyVariantId: variant.id,
          sku: variant.sku,
          price: variant.price,
          inventoryQuantity: variant.inventoryQuantity,
        })),
      })),
      db: {
        linkedRows: checks.length,
        missingInShopify: count((c) => !c.existsInShopify),
        dbPublishedButNotLiveOnShopify: count((c) => c.dbPublished && !(c.shopifyStatus === "ACTIVE" && c.publishedOnOnlineStore === true)),
        liveOnShopifyButNotDbPublished: count((c) => !c.dbPublished && c.shopifyStatus === "ACTIVE" && c.publishedOnOnlineStore === true),
        liveOnShopifyWithoutGate: count((c) => c.shopifyStatus === "ACTIVE" && c.publishedOnOnlineStore === true && !c.gatePassed),
        verifiedMapping: count((c) => c.existsInShopify && c.skuMatches === true && c.variantIdMatches === true && c.priceMatches === true && c.inventoryMatches === true && c.publicationMatches === true && Boolean(c.supplierVariantId)),
        skuMismatch: count((c) => c.skuMatches === false),
        priceMismatch: count((c) => c.priceMatches === false),
        inventoryMismatch: count((c) => c.inventoryMatches === false),
        publicationMismatch: count((c) => c.publicationMatches === false),
        withoutSupplierVariant: count((c) => !c.supplierVariantId),
        legacyNumericIds: count((c) => c.legacyNumericId),
      },
      samples: {
        dbPublishedButNotLiveOnShopify: checks.filter((c) => c.dbPublished && !(c.shopifyStatus === "ACTIVE" && c.publishedOnOnlineStore === true)).slice(0, 5),
        liveOnShopifyWithoutGate: checks.filter((c) => c.shopifyStatus === "ACTIVE" && c.publishedOnOnlineStore === true && !c.gatePassed).slice(0, 5),
        mismatches: checks.filter((c) => c.skuMatches === false || c.priceMatches === false || c.inventoryMatches === false || c.publicationMatches === false).slice(0, 5),
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // A Shopify outage must report clearly, not as an opaque 500 page.
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message.slice(0, 400) : String(error) }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
