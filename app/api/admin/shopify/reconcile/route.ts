import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getOnlineStorePublicationId, shopifyGraphQL } from "@/lib/shopify/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
    const shopify: ShopifyNode[] = [];
    let after: string | null = null;
    for (let page = 0; page < 8; page += 1) {
      const data: { products: { nodes: ShopifyNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await shopifyGraphQL(
        `query TracerProducts($after: String, $publicationId: ID!) {
          products(first: 100, after: $after, query: "vendor:TRACER") {
            nodes {
              id handle status vendor totalInventory
              publishedOnPublication(publicationId: $publicationId)
              featuredMedia { id }
              variants(first: 5) { nodes { id sku price inventoryQuantity } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { after, publicationId },
      );
      shopify.push(...data.products.nodes);
      if (!data.products.pageInfo.hasNextPage) break;
      after = data.products.pageInfo.endCursor;
    }

    const db = createSupabaseAdminClient();
    const { data: rows, error } = await db
      .from("shop_listings")
      .select("id, published, pipeline_reason, selection_reasons, selling_price, inventory, orderable, supplier_name, supplier_product_id, supplier_variant_id, shopify_product_id, shopify_variant_id, shopify_sync_status")
      .not("shopify_product_id", "is", null)
      .limit(2000);
    if (error) throw new Error(error.message);

    // Legacy rows may hold numeric REST ids; compare on the numeric tail.
    const tail = (id: unknown) => String(id ?? "").split("/").pop() ?? "";
    const byId = new Map(shopify.map((node) => [tail(node.id), node]));
    const linkedIds = new Set((rows ?? []).map((row) => tail(row.shopify_product_id)));
    const checks = (rows ?? []).map((row) => {
      const node = byId.get(tail(row.shopify_product_id));
      const variant = node?.variants.nodes.find((v) => tail(v.id) === tail(row.shopify_variant_id)) ?? node?.variants.nodes[0];
      const expectedSku = `TRC-${row.supplier_variant_id || row.supplier_product_id || row.id}`.slice(0, 100);
      const gate = Array.isArray(row.selection_reasons) && row.selection_reasons.map(String).includes("sales_test_gate_passed");
      return {
        listingId: String(row.id),
        existsInShopify: Boolean(node),
        shopifyStatus: node?.status ?? null,
        publishedOnOnlineStore: node?.publishedOnPublication ?? null,
        dbPublished: row.published === true,
        gatePassed: gate,
        skuMatches: variant ? variant.sku === expectedSku : null,
        variantIdMatches: variant ? !row.shopify_variant_id || tail(variant.id) === tail(row.shopify_variant_id) : null,
        legacyNumericId: /^\d+$/.test(String(row.shopify_product_id ?? "")),
        priceMatches: variant ? Number(variant.price) === Number(row.selling_price) : null,
        shopifyInventory: variant?.inventoryQuantity ?? null,
        dbInventory: row.inventory,
        hasImage: Boolean(node?.featuredMedia),
        supplierVariantId: row.supplier_variant_id ?? null,
        syncStatus: row.shopify_sync_status ?? null,
      };
    });

    const count = (predicate: (c: (typeof checks)[number]) => boolean) => checks.filter(predicate).length;
    return NextResponse.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      shopify: {
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
        verifiedMapping: count((c) => c.existsInShopify && c.skuMatches === true && c.variantIdMatches === true && c.priceMatches === true && Boolean(c.supplierVariantId)),
        skuMismatch: count((c) => c.skuMatches === false),
        priceMismatch: count((c) => c.priceMatches === false),
        inventoryMismatch: count((c) => c.shopifyInventory !== null && c.dbInventory !== null && Number(c.shopifyInventory) !== Number(c.dbInventory)),
        withoutSupplierVariant: count((c) => !c.supplierVariantId),
        legacyNumericIds: count((c) => c.legacyNumericId),
      },
      samples: {
        dbPublishedButNotLiveOnShopify: checks.filter((c) => c.dbPublished && !(c.shopifyStatus === "ACTIVE" && c.publishedOnOnlineStore === true)).slice(0, 5),
        liveOnShopifyWithoutGate: checks.filter((c) => c.shopifyStatus === "ACTIVE" && c.publishedOnOnlineStore === true && !c.gatePassed).slice(0, 5),
        mismatches: checks.filter((c) => c.skuMatches === false || c.priceMatches === false).slice(0, 5),
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // A Shopify outage must report clearly, not as an opaque 500 page.
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message.slice(0, 400) : String(error) }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
