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

/** Read-only production counts for TRACER, BASE, Shopify, orders, procurement and tracking. */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const db = createSupabaseAdminClient();
    const freshSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [cronRunTotal, cronRunFailures, recentCronRows, baseLive, shopifyLive] = await Promise.all([
      count(db, "cron_runs", q => q.gte("started_at", freshSince)),
      count(db, "cron_runs", q => q.gte("started_at", freshSince).eq("status", "failed")),
      db.from("cron_runs").select("job_name,status,started_at,finished_at,processed,failed")
        .gte("started_at", freshSince).order("started_at", { ascending: false }).limit(200),
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
            productsCount: { count: number; precision: "EXACT" | "AT_LEAST" };
            activeProductsCount: { count: number; precision: "EXACT" | "AT_LEAST" };
          }>(`query TracerReadOnlyCommerceStatus {
            productsCount(limit: 10000) { count precision }
            activeProductsCount: productsCount(query: "status:active", limit: 10000) { count precision }
          }`);
          return {
            ok: live.productsCount.precision === "EXACT" && live.activeProductsCount.precision === "EXACT",
            configured: true,
            totalProducts: live.productsCount.count,
            activeProducts: live.activeProductsCount.count,
            countPrecision: live.productsCount.precision,
            activeCountPrecision: live.activeProductsCount.precision,
          };
        } catch (error) {
          return { ok: false, configured: true, error: error instanceof Error ? error.message.split("\n")[0].slice(0, 160) : "shopify_probe_failed" };
        }
      })(),
    ]);
    if (recentCronRows.error) throw new Error("cron_runs_recent_read_failed:" + recentCronRows.error.message);
    const latestCronByJob = new Map<string, Record<string, unknown>>();
    for (const row of recentCronRows.data ?? []) {
      const jobName = typeof row.job_name === "string" ? row.job_name : "unknown";
      if (!latestCronByJob.has(jobName)) latestCronByJob.set(jobName, {
        jobName, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at,
        processed: row.processed ?? 0, failed: row.failed ?? 0,
      });
    }
    const [
      products, activeProducts, variants,
      offersDiscovered, offersVerified, offersUnavailable, offersError, cjFreshOrderable,
      prices, profitablePrices,
      baseTotal, basePublished, basePending, baseHidden, baseError, baseWithoutExternalId, baseLastSynced,
      shopifyTotal, shopifyPublished, shopifyPending, shopifyHidden, shopifyError, shopifyWithoutExternalId, shopifyLastSynced,
      baseOrders, basePaid, baseShipped, baseLastOrder,
      shopifyOrders, shopifyPaid, shopifyShipped, shopifyLastOrder,
      procurementPending, procurementProcessing, procurementSubmitted, procurementConfirmed, procurementShipped, procurementFailed, procurementCancelled,
      procurementWithTracking, procurementLastSubmitted, procurementLastShipped,
      lastOfferCheck, lastPriceCalculation, approvalRequested, approvalGranted,
      legacyListings, legacyPublished,
    ] = await Promise.all([
      count(db, "commerce_products"), count(db, "commerce_products", q => q.eq("active", true)), count(db, "commerce_variants"),
      count(db, "supplier_offers", q => q.eq("source_status", "discovered")),
      count(db, "supplier_offers", q => q.eq("source_status", "verified")),
      count(db, "supplier_offers", q => q.eq("source_status", "unavailable")),
      count(db, "supplier_offers", q => q.eq("source_status", "error")),
      count(db, "supplier_offers", q => q.eq("supplier_code", "cj").eq("source_status", "verified").eq("tracking_supported", true).eq("ship_to", "JP").gt("inventory", 0).gte("last_checked_at", freshSince)),
      count(db, "commerce_prices"), count(db, "commerce_prices", q => q.eq("currency", "JPY").gt("expected_profit", 0)),
      count(db, "channel_listings", q => q.eq("channel", "base")),
      count(db, "channel_listings", q => q.eq("channel", "base").eq("status", "published")),
      count(db, "channel_listings", q => q.eq("channel", "base").eq("status", "pending")),
      count(db, "channel_listings", q => q.eq("channel", "base").eq("status", "hidden")),
      count(db, "channel_listings", q => q.eq("channel", "base").eq("status", "error")),
      count(db, "channel_listings", q => q.eq("channel", "base").is("external_product_id", null)),
      latest(db, "channel_listings", "last_synced_at", q => q.eq("channel", "base")),
      count(db, "channel_listings", q => q.eq("channel", "shopify")),
      count(db, "channel_listings", q => q.eq("channel", "shopify").eq("status", "published")),
      count(db, "channel_listings", q => q.eq("channel", "shopify").eq("status", "pending")),
      count(db, "channel_listings", q => q.eq("channel", "shopify").eq("status", "hidden")),
      count(db, "channel_listings", q => q.eq("channel", "shopify").eq("status", "error")),
      count(db, "channel_listings", q => q.eq("channel", "shopify").is("external_product_id", null)),
      latest(db, "channel_listings", "last_synced_at", q => q.eq("channel", "shopify")),
      count(db, "commerce_orders", q => q.eq("channel", "base")),
      count(db, "commerce_orders", q => q.eq("channel", "base").eq("payment_status", "paid")),
      count(db, "commerce_orders", q => q.eq("channel", "base").eq("fulfillment_status", "shipped")),
      latest(db, "commerce_orders", "received_at", q => q.eq("channel", "base")),
      count(db, "commerce_orders", q => q.eq("channel", "shopify")),
      count(db, "commerce_orders", q => q.eq("channel", "shopify").eq("payment_status", "paid")),
      count(db, "commerce_orders", q => q.eq("channel", "shopify").eq("fulfillment_status", "shipped")),
      latest(db, "commerce_orders", "received_at", q => q.eq("channel", "shopify")),
      count(db, "procurement_orders", q => q.eq("status", "pending")),
      count(db, "procurement_orders", q => q.eq("status", "processing")),
      count(db, "procurement_orders", q => q.eq("status", "submitted")),
      count(db, "procurement_orders", q => q.eq("status", "confirmed")),
      count(db, "procurement_orders", q => q.eq("status", "shipped")),
      count(db, "procurement_orders", q => q.eq("status", "failed")),
      count(db, "procurement_orders", q => q.eq("status", "cancelled")),
      count(db, "procurement_orders", q => q.not("tracking_number", "is", null)),
      latest(db, "procurement_orders", "submitted_at"),
      latest(db, "procurement_orders", "shipped_at"),
      latest(db, "supplier_offers", "last_checked_at"),
      latest(db, "commerce_prices", "calculated_at"),
      count(db, "commerce_events", q => q.eq("event_type", "procurement_approval_requested")),
      count(db, "commerce_events", q => q.eq("event_type", "procurement_approved")),
      count(db, "shop_listings"), count(db, "shop_listings", q => q.eq("published", true)),
    ]);

    return NextResponse.json({
      ok: baseLive.ok && shopifyLive.ok, readOnly: true, generatedAt: new Date().toISOString(),
      catalog: { products, activeProducts, variants },
      supplierOffers: { discovered: offersDiscovered, verified: offersVerified, unavailable: offersUnavailable, error: offersError, cjFreshOrderable, lastCheckedAt: lastOfferCheck },
      prices: { total: prices, profitableJpy: profitablePrices, lastCalculatedAt: lastPriceCalculation },
      channels: {
        base: { total: baseTotal, published: basePublished, pending: basePending, hidden: baseHidden, error: baseError, withoutExternalId: baseWithoutExternalId, lastSyncedAt: baseLastSynced },
        shopify: { total: shopifyTotal, published: shopifyPublished, pending: shopifyPending, hidden: shopifyHidden, error: shopifyError, withoutExternalId: shopifyWithoutExternalId, lastSyncedAt: shopifyLastSynced },
        legacyBase: { shopListings: legacyListings, published: legacyPublished },
      },
      livePlatforms: { base: baseLive, shopify: shopifyLive },
      orders: {
        base: { total: baseOrders, paid: basePaid, shipped: baseShipped, lastReceivedAt: baseLastOrder },
        shopify: { total: shopifyOrders, paid: shopifyPaid, shipped: shopifyShipped, lastReceivedAt: shopifyLastOrder },
      },
      procurement: {
        pending: procurementPending, processing: procurementProcessing, submitted: procurementSubmitted,
        confirmed: procurementConfirmed, shipped: procurementShipped, failed: procurementFailed,
        cancelled: procurementCancelled, withTracking: procurementWithTracking,
        lastSubmittedAt: procurementLastSubmitted, lastShippedAt: procurementLastShipped,
        approvalRequired: isProcurementApprovalRequired(),
      },
      approvalEvents: { requested: approvalRequested, approved: approvalGranted },
      cronRuns: { last24Hours: cronRunTotal, failedLast24Hours: cronRunFailures, latestByJob: [...latestCronByJob.values()] },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    return NextResponse.json({ ok: false, readOnly: true, error: message }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
