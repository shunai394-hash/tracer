import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isProcurementApprovalRequired } from "@/lib/commerce/procurement-approval";
import { BASE_ITEMS_MAX_PAGES, isBaseConfigured, probeBaseReadOnly } from "@/lib/channels/base";
import { isShopifyConfigured, shopifyGraphQL } from "@/lib/shopify/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Db = ReturnType<typeof createSupabaseAdminClient>;
type Filter = (query: any) => any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function count(db: Db, table: string, filter: Filter = (q) => q): Promise<number> {
  const { count: total, error } = await filter(db.from(table).select("*", { count: "exact", head: true }));
  if (error) throw new Error(`${table}_count_failed:${error.message}`);
  return total ?? 0;
}

async function latest(db: Db, table: string, column: string, filter: Filter = (q) => q): Promise<string | null> {
  const { data, error } = await filter(db.from(table).select(column).not(column, "is", null)).order(column, { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`${table}_${column}_latest_failed:${error.message}`);
  const value = data ? (data as Record<string, unknown>)[column] : null;
  return typeof value === "string" ? value : null;
}

/**
 * Read-only status of the TRACER commerce pipeline: catalog, supplier offers,
 * prices, BASE/Shopify channel listings, orders, procurement and tracking,
 * plus the newest timestamp each scheduled stage wrote (to show whether the
 * crons are actually running). Counts only; no customer data; no writes.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  try {
    const db = createSupabaseAdminClient();
    const freshSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const channel = async (name: "base" | "shopify") => ({
      total: await count(db, "channel_listings", (q) => q.eq("channel", name)),
      published: await count(db, "channel_listings", (q) => q.eq("channel", name).eq("status", "published")),
      pending: await count(db, "channel_listings", (q) => q.eq("channel", name).eq("status", "pending")),
      hidden: await count(db, "channel_listings", (q) => q.eq("channel", name).eq("status", "hidden")),
      error: await count(db, "channel_listings", (q) => q.eq("channel", name).eq("status", "error")),
      withoutExternalId: await count(db, "channel_listings", (q) => q.eq("channel", name).is("external_product_id", null)),
      lastSyncedAt: await latest(db, "channel_listings", "last_synced_at", (q) => q.eq("channel", name)),
    });
    const orders = async (name: "base" | "shopify") => ({
      total: await count(db, "commerce_orders", (q) => q.eq("channel", name)),
      paid: await count(db, "commerce_orders", (q) => q.eq("channel", name).eq("payment_status", "paid")),
      shipped: await count(db, "commerce_orders", (q) => q.eq("channel", name).eq("fulfillment_status", "shipped")),
      lastReceivedAt: await latest(db, "commerce_orders", "received_at", (q) => q.eq("channel", name)),
    });
    // Query the live storefront APIs read-only as well as the internal mapping DB.
    // A DB "published" row alone does not prove the item exists on the platform.
    const [baseLive, shopifyLive] = await Promise.all([
      (async () => {
        if (!isBaseConfigured()) return { ok: false, configured: false, error: "base_oauth_not_configured" };
        try {
          const probe = await probeBaseReadOnly({ itemPageLimit: 100, itemMaxPages: BASE_ITEMS_MAX_PAGES });
          return {
            ok: probe.orders.apiStatus === 200 && probe.items.apiStatus === 200 && probe.items.complete,
            configured: true,
            ordersApiStatus: probe.orders.apiStatus,
            ordersReturned: probe.orders.countReturned,
            itemsApiStatus: probe.items.apiStatus,
            itemsScanned: probe.items.countReturned,
            visibleItems: probe.items.visibleCount,
            hiddenItems: probe.items.hiddenCount,
            unknownVisibility: probe.items.unknownVisibilityCount,
            pagesScanned: probe.items.pages,
            scanCap: BASE_ITEMS_MAX_PAGES * 100,
            scanComplete: probe.items.complete,
            errorStage: probe.items.errorStage,
          };
        } catch (error) {
          return { ok: false, configured: true, error: error instanceof Error ? error.message.split(":")[0].slice(0, 100) : "base_probe_failed" };
        }
      })(),
      (async () => {
        if (!isShopifyConfigured()) return { ok: false, configured: false, error: "shopify_admin_api_not_configured" };
        try {
          const live = await shopifyGraphQL<{
            productsCount: { count: number };
            activeProductsCount: { count: number };
          }>(`query TracerReadOnlyCommerceStatus {
            productsCount(limit: 1) { count }
            activeProductsCount: productsCount(query: "status:active", limit: 1) { count }
          }`);
          return { ok: true, configured: true, totalProducts: live.productsCount.count, activeProducts: live.activeProductsCount.count };
        } catch (error) {
          return { ok: false, configured: true, error: error instanceof Error ? error.message.split("\\n")[0].slice(0, 160) : "shopify_probe_failed" };
        }
      })(),
    ]);

    const procurementStatuses = ["pending", "processing", "submitted", "confirmed", "shipped", "failed", "cancelled"] as const;
    const procurement: Record<string, number> = {};
    for (const status of procurementStatuses) procurement[status] = await count(db, "procurement_orders", (q) => q.eq("status", status));
    const offerStatuses = ["discovered", "verified", "unavailable", "error"] as const;
    const offers: Record<string, number> = {};
    for (const status of offerStatuses) offers[status] = await count(db, "supplier_offers", (q) => q.eq("source_status", status));

    return NextResponse.json({
      ok: baseLive.ok && shopifyLive.ok,
      readOnly: true,
      generatedAt: new Date().toISOString(),
      catalog: {
        products: await count(db, "commerce_products"),
        activeProducts: await count(db, "commerce_products", (q) => q.eq("active", true)),
        variants: await count(db, "commerce_variants"),
      },
      supplierOffers: {
        byStatus: offers,
        cjOrderableFresh: await count(db, "supplier_offers", (q) => q.eq("supplier_code", "cj").eq("source_status", "verified")
          .eq("tracking_supported", true).eq("ship_to", "JP").gt("inventory", 0).gte("last_checked_at", freshSince)),
        lastCheckedAt: await latest(db, "supplier_offers", "last_checked_at"),
      },
      prices: {
        total: await count(db, "commerce_prices"),
        profitable: await count(db, "commerce_prices", (q) => q.eq("currency", "JPY").gt("expected_profit", 0)),
      },
      channels: { base: await channel("base"), shopify: await channel("shopify") },
      livePlatforms: { base: baseLive, shopify: shopifyLive },
      orders: { base: await orders("base"), shopify: await orders("shopify") },
      procurement: {
        byStatus: procurement,
        withTracking: await count(db, "procurement_orders", (q) => q.not("tracking_number", "is", null)),
        approvalRequired: isProcurementApprovalRequired(),
        approvalRequests: await count(db, "commerce_events", (q) => q.eq("event_type", "procurement_approval_requested")),
        approvals: await count(db, "commerce_events", (q) => q.eq("event_type", "procurement_approved")),
        lastSubmittedAt: await latest(db, "procurement_orders", "submitted_at"),
      },
      legacy: {
        shopListings: await count(db, "shop_listings"),
        shopListingsPublished: await count(db, "shop_listings", (q) => q.eq("published", true)),
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message.slice(0, 300) : String(error) }, { status: 500 });
  }
}
