import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOnlineStorePublicationId, shopifyGraphQL } from "@/lib/shopify/admin";
import { getStorefrontStockCap, toStorefrontStockQuantity } from "@/lib/shopify/storefront-stock";
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
  variants: { nodes: Array<{ id: string; sku: string | null; price: string | null; inventoryQuantity: number | null }> };
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
    // Scan the whole store to the last page (no fixed page cap), then keep
    // vendor TRACER products for the legacy checks below.
    const storeNodes: ShopifyNode[] = [];
    let after: string | null = null;
    let scanComplete = false;
    const deadline = Date.now() + 90_000;
    for (let page = 0; page < 200 && Date.now() < deadline; page += 1) {
      let data: { products: { nodes: ShopifyNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null = null;
      for (let attempt = 0; attempt < 6 && !data; attempt += 1) {
        try {
          data = await shopifyGraphQL(
            `query TracerStoreProducts($after: String, $publicationId: ID!) {
              products(first: 100, after: $after, sortKey: ID) {
                nodes {
                  id handle status vendor totalInventory
                  publishedOnPublication(publicationId: $publicationId)
                  featuredMedia { id }
                  variants(first: 3) { nodes { id sku price inventoryQuantity } }
                }
                pageInfo { hasNextPage endCursor }
              }
            }`,
            { after, publicationId },
          );
        } catch (error) {
          if (!/throttl/i.test(error instanceof Error ? error.message : String(error)) || attempt === 5) throw error;
          await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
        }
      }
      if (!data) break;
      storeNodes.push(...data.products.nodes);
      if (!data.products.pageInfo.hasNextPage) { scanComplete = true; break; }
      if (!data.products.pageInfo.endCursor || data.products.pageInfo.endCursor === after) break;
      after = data.products.pageInfo.endCursor;
    }
    const shopify = storeNodes.filter((node) => node.vendor === "TRACER");

    const db = createSupabaseAdminClient();
    const { data: rows, error } = await db
      .from("shop_listings")
      .select("id, published, pipeline_reason, selection_reasons, selling_price, inventory, orderable, tracking_available, supplier_name, supplier_product_id, supplier_variant_id, shopify_product_id, shopify_variant_id, shopify_sync_status")
      .not("shopify_product_id", "is", null)
      .limit(10000);
    if (error) throw new Error(error.message);

    const commerceRows: CommerceShopifyRow[] = [];
    for (let from = 0; ; from += 1000) {
      if (from >= 50_000) throw new Error("commerce_channel_scan_incomplete");
      const { data: page, error: commerceError } = await db.from("channel_listings")
        .select("variant_id,external_product_id,external_variant_id,external_sku,status,selling_price")
        .eq("channel", "shopify").order("id", { ascending: true }).range(from, from + 999);
      if (commerceError) throw new Error(commerceError.message);
      commerceRows.push(...((page ?? []) as CommerceShopifyRow[]));
      if ((page ?? []).length < 1000) break;
    }
    const catalog = reconcileShopifyCatalog({
      nodes: storeNodes.map((node) => ({ ...node, variants: node.variants.nodes })),
      scanComplete,
      commerceRows,
      probeVariantIds: new URL(request.url).searchParams.getAll("variant").filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 20),
      legacyRows: (rows ?? []).map((row) => ({ id: String(row.id), shopify_product_id: row.shopify_product_id == null ? null : String(row.shopify_product_id) })),
    });

    // Legacy rows may hold numeric REST ids; compare on the numeric tail.
    const tail = (id: unknown) => String(id ?? "").split("/").pop() ?? "";
    const byId = new Map(shopify.map((node) => [tail(node.id), node]));
    const linkedIds = new Set((rows ?? []).map((row) => tail(row.shopify_product_id)));
    const checks = (rows ?? []).map((row) => {
      const node = byId.get(tail(row.shopify_product_id));
      const variant = node?.variants.nodes.find((v) => tail(v.id) === tail(row.shopify_variant_id)) ?? node?.variants.nodes[0];
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
        shopifyStatus: node?.status ?? null,
        publishedOnOnlineStore: node?.publishedOnPublication ?? null,
        dbPublished: row.published === true,
        expectedLive,
        publicationMatches: node ? actualLive === expectedLive : null,
        gatePassed: gate,
        skuMatches: variant ? variant.sku === expectedSku : null,
        variantIdMatches: variant ? !row.shopify_variant_id || tail(variant.id) === tail(row.shopify_variant_id) : null,
        legacyNumericId: /^\d+$/.test(String(row.shopify_product_id ?? "")),
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
    return NextResponse.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      catalog,
      shopify: {
        scanComplete,
        tracerProducts: shopify.length,
        active: shopify.filter((n) => n.status === "ACTIVE").length,
        publishedOnOnlineStore: shopify.filter((n) => n.publishedOnPublication).length,
        activeAndPublished: shopify.filter((n) => n.status === "ACTIVE" && n.publishedOnPublication).length,
        withoutImage: shopify.filter((n) => !n.featuredMedia).length,
        notLinkedInDb: shopify.filter((n) => !linkedIds.has(tail(n.id))).length,
      },
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
