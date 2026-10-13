import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchBaseItemsSnapshot } from "@/lib/channels/base";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";
import { getOnlineStorePublicationId, shopifyGraphQL } from "@/lib/shopify/admin";
import { syncPublishedListingsToShopify } from "@/lib/shopify/sync-published-listings";
import {
  buildThreeSiteCorrespondence,
  type CorrespondenceListing,
  type CorrespondenceShopifyProduct,
} from "@/lib/channels/three-site-correspondence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LISTING_SELECT = "id,title,selling_price,inventory,published,base_item_id,shopify_product_id,shopify_variant_id,base_last_error,base_publication_status,shopify_sync_status,shopify_sync_error,pipeline_stage,pipeline_status,pipeline_reason";

type ListingRow = CorrespondenceListing & Record<string, unknown>;

async function readListing(listingId: string): Promise<ListingRow | null> {
  const db = createSupabaseAdminClient();
  const { data, error } = await db.from("shop_listings").select(LISTING_SELECT).eq("id", listingId).maybeSingle();
  if (error) throw new Error(`shop_listings_read_failed:${error.message}`);
  return (data as ListingRow | null) ?? null;
}

async function readShopifyProduct(productId: unknown): Promise<CorrespondenceShopifyProduct[]> {
  const raw = String(productId ?? "").trim();
  if (!raw) return [];
  const gid = raw.startsWith("gid://") ? raw : `gid://shopify/Product/${raw}`;
  const publicationId = await getOnlineStorePublicationId();
  const data = await shopifyGraphQL<{
    product: (Omit<CorrespondenceShopifyProduct, "variants"> & { variants: { nodes: CorrespondenceShopifyProduct["variants"]; pageInfo: { hasNextPage: boolean } } }) | null;
  }>(
    `query TracerSingleProduct($id: ID!, $publicationId: ID!) {
      product(id: $id) {
        id title status
        publishedOnPublication(publicationId: $publicationId)
        variants(first: 250) { nodes { id sku price inventoryQuantity } pageInfo { hasNextPage } }
      }
    }`,
    { id: gid, publicationId },
  );
  if (data.product?.variants.pageInfo.hasNextPage) throw new Error("SHOPIFY_VARIANTS_INCOMPLETE");
  return data.product ? [{ ...data.product, variants: data.product.variants.nodes }] : [];
}

/** Live read of both channels for one listing, matched only by its stored external IDs. */
async function observe(listing: ListingRow) {
  const [baseSnapshot, shopifyProducts] = await Promise.all([
    listing.base_item_id ? fetchBaseItemsSnapshot() : Promise.resolve({ items: [] as Record<string, unknown>[] }),
    readShopifyProduct(listing.shopify_product_id),
  ]);
  const baseId = String(listing.base_item_id ?? "");
  const report = buildThreeSiteCorrespondence({
    listings: [listing],
    baseItems: baseSnapshot.items
      .filter((item) => String(item.item_id ?? "") === baseId)
      .map((item) => ({ item_id: item.item_id, identifier: item.identifier, title: item.title, price: item.price, stock: item.stock, visible: item.visible })),
    shopifyProducts,
  });
  const row = report.rows[0];
  const bothLive = row.base.live === true && row.shopify.live === true;
  return {
    row,
    acceptance: {
      bothExternalIds: Boolean(row.base.externalId && row.shopify.externalId),
      bothProductsExist: row.base.found && row.shopify.found,
      titlePriceVisibilityAgree: row.issues.every((issue) => !/(title|price|visibility|live)/.test(issue)),
      notSoldWithoutStockOrWhenUnpublished: row.issues.every((issue) => !/(live_but_tracer_unpublished|live_without_tracer_stock|stock_exceeds_tracer)/.test(issue)),
      liveOnBoth: bothLive,
      passed: row.consistent,
    },
  };
}

/**
 * Syncs exactly one TRACER listing to BASE and Shopify, then re-reads both
 * channels and checks that the listing has both external IDs and that title,
 * price and visibility agree. TRACER is the source: channel data is never
 * copied back.
 *
 * POST { "listingId": "<uuid>", "apply": false }
 * - apply false (default): read-only; reports the current three-site state.
 * - apply true: runs the normal Shopify and BASE publishers for this one
 *   listing. Their own gates decide whether it is published or hidden, and a
 *   failure is recorded on the listing (shopify_sync_error / base_last_error),
 *   so the same call can be re-run. Nothing here places a supplier order.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  let body: { listingId?: unknown; apply?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const listingId = typeof body.listingId === "string" ? body.listingId.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(listingId)) return NextResponse.json({ ok: false, error: "listing_id_required" }, { status: 400 });
  const apply = body.apply === true;

  try {
    const before = await readListing(listingId);
    if (!before) return NextResponse.json({ ok: false, error: "listing_not_found" }, { status: 404 });
    const beforeState = await observe(before);
    if (!apply) {
      return NextResponse.json({ ok: true, apply: false, listingId, before: beforeState }, { headers: { "Cache-Control": "no-store" } });
    }

    const shopify = await syncPublishedListingsToShopify(1, [listingId]);
    const base = await publishPublishedListingsToBase(1, [listingId]);
    const after = await readListing(listingId);
    if (!after) throw new Error("listing_disappeared_after_sync");
    const afterState = await observe(after);
    return NextResponse.json({
      ok: afterState.acceptance.passed,
      apply: true,
      listingId,
      before: beforeState,
      sync: {
        shopify: { synced: shopify.synced, failed: shopify.failed, errors: shopify.errors.slice(0, 5) },
        base: { published: base.published, hidden: base.hidden, skipped: base.skipped, failed: base.failed, results: base.results.slice(0, 5) },
      },
      after: afterState,
      recordedFailure: {
        shopifySyncStatus: after.shopify_sync_status ?? null,
        shopifySyncError: after.shopify_sync_error ?? null,
        baseLastError: after.base_last_error ?? null,
      },
    }, { status: afterState.acceptance.passed ? 200 : 207, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message.slice(0, 400) : String(error) },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
