import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchBaseItemsSnapshot } from "@/lib/channels/base";
import { getOnlineStorePublicationId, shopifyGraphQL } from "@/lib/shopify/admin";
import {
  buildThreeSiteCorrespondence,
  type CorrespondenceListing,
  type CorrespondenceShopifyProduct,
} from "@/lib/channels/three-site-correspondence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type ShopifyNode = {
  id: string;
  title: string | null;
  status: string | null;
  publishedOnPublication: boolean | null;
  variants: { nodes: CorrespondenceShopifyProduct["variants"] };
};

async function fetchShopifyTracerProducts(): Promise<CorrespondenceShopifyProduct[]> {
  const publicationId = await getOnlineStorePublicationId();
  const products: CorrespondenceShopifyProduct[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const data: { products: { nodes: ShopifyNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await shopifyGraphQL(
      `query TracerCorrespondence($after: String, $publicationId: ID!) {
        products(first: 100, after: $after, query: "vendor:TRACER") {
          nodes {
            id title status
            publishedOnPublication(publicationId: $publicationId)
            variants(first: 250) { nodes { id sku price inventoryQuantity } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { after, publicationId },
    );
    products.push(...data.products.nodes.map((node) => ({ ...node, variants: node.variants.nodes })));
    if (!data.products.pageInfo.hasNextPage) return products;
    after = data.products.pageInfo.endCursor;
  }
  throw new Error("SHOPIFY_TRACER_CATALOG_INCOMPLETE");
}

/**
 * Read-only TRACER ↔ BASE ↔ Shopify correspondence table. TRACER is the
 * master; channel products are matched only through the external IDs stored
 * on shop_listings. Nothing is written to TRACER, BASE or Shopify.
 *
 * GET ?detail=1&offset=0&limit=200 adds per-listing rows (titles and prices).
 * Without detail only counts and listing IDs per issue are returned, so the
 * output is safe for logs.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const detail = url.searchParams.get("detail") === "1";
  const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset") ?? 0)) || 0);
  const limit = Math.min(500, Math.max(1, Math.floor(Number(url.searchParams.get("limit") ?? 200)) || 200));

  try {
    const db = createSupabaseAdminClient();
    const { data: listings, error } = await db
      .from("shop_listings")
      .select("id,title,selling_price,inventory,published,base_item_id,shopify_product_id,shopify_variant_id")
      .or("base_item_id.not.is.null,shopify_product_id.not.is.null,published.eq.true")
      .limit(5000);
    if (error) throw new Error(`shop_listings_read_failed:${error.message}`);
    if ((listings ?? []).length >= 5000) throw new Error("TRACER_LISTINGS_INCOMPLETE");

    const [baseSnapshot, shopifyProducts] = await Promise.all([fetchBaseItemsSnapshot(), fetchShopifyTracerProducts()]);
    const report = buildThreeSiteCorrespondence({
      listings: (listings ?? []) as CorrespondenceListing[],
      baseItems: baseSnapshot.items.map((item) => ({
        item_id: item.item_id,
        identifier: item.identifier,
        title: item.title,
        price: item.price,
        stock: item.stock,
        visible: item.visible,
      })),
      shopifyProducts,
    });

    const listingIdsByIssue: Record<string, string[]> = {};
    for (const row of report.rows) {
      for (const issue of row.issues) (listingIdsByIssue[issue] ??= []).push(row.listingId);
    }
    return NextResponse.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      summary: report.summary,
      consistentListingIds: report.rows.filter((row) => row.consistent).map((row) => row.listingId),
      listingIdsByIssue: Object.fromEntries(Object.entries(listingIdsByIssue).map(([issue, ids]) => [issue, ids.slice(0, 50)])),
      ...(detail
        ? {
            rows: report.rows.slice(offset, offset + limit),
            unlinkedBaseItems: report.unlinkedBaseItems.slice(0, 200),
            unlinkedShopifyProducts: report.unlinkedShopifyProducts.slice(0, 200),
            page: { offset, limit, total: report.rows.length },
          }
        : {}),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // An incomplete channel read must not be reported as an empty catalog.
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message.slice(0, 400) : String(error) },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
