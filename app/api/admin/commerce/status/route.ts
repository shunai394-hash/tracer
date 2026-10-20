import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { newfindDeliveryOutcome, tallyNewfindDeliveries } from "@/lib/integration/newfind-delivery-state";
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

/** Reads every row of a filtered query in 1000-row pages (PostgREST caps a single response). */
async function readAll(db: Db, table: string, columns: string, orderColumn: string, filter: Filter): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await filter(db.from(table).select(columns)).order(orderColumn, { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`${table}_read_failed:${error.message}`);
    rows.push(...((data ?? []) as Array<Record<string, unknown>>));
    if ((data ?? []).length < 1000) return rows;
  }
  throw new Error(`${table}_read_incomplete`);
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
            missingItemIds: probe.items.missingItemIdCount,
            duplicateRowsSkipped: probe.items.duplicateItemCount,
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
            ordersCount: { count: number; precision: "EXACT" | "AT_LEAST" };
          }>(`query TracerReadOnlyCommerceStatus {
            productsCount(limit: 10000) { count precision }
            activeProductsCount: productsCount(query: "status:active", limit: 10000) { count precision }
            ordersCount(limit: 10000) { count precision }
          }`);
          return {
            ok: live.productsCount.precision === "EXACT" && live.activeProductsCount.precision === "EXACT",
            configured: true,
            totalProducts: live.productsCount.count,
            activeProducts: live.activeProductsCount.count,
            countSource: "shopify_products_count_api",
            countPrecision: live.productsCount.precision,
            activeCountPrecision: live.activeProductsCount.precision,
            ordersCount: live.ordersCount.count,
            ordersCountPrecision: live.ordersCount.precision,
            ordersCountSource: "shopify_orders_count_api",
          };
        } catch (error) {
          return { ok: false, configured: true, error: error instanceof Error ? error.message.split("\n")[0].slice(0, 160) : "shopify_probe_failed" };
        }
      })(),
    ]);
    if (recentCronRows.error) throw new Error("cron_runs_recent_read_failed:" + recentCronRows.error.message);
    const [failedCronRows, listingErrorRows, supplierOfferErrorRows] = await Promise.all([
      db.from("cron_runs").select("job_name,error").gte("started_at", freshSince).eq("status", "failed").limit(500),
      (async () => ({ data: await readAll(db, "channel_listings", "channel,variant_id,external_product_id,last_error,last_synced_at,commerce_variants(sku,title_ja,supplier_offers(supplier_code,supplier_product_id,supplier_variant_id,source_status,last_checked_at))", "variant_id", q => q.eq("status", "error")), error: null as unknown as { message: string } | null }))(),
      db.from("supplier_offers").select("supplier_code,supplier_product_id,supplier_variant_id,source_status,last_checked_at,updated_at,raw_data").eq("source_status", "error").order("updated_at", { ascending: false }).limit(100),
    ]);
    // NEWFIND: count from the rows themselves with one outcome definition
    // (receiver ACK required), all-time and for the same 24h window.
    const [legacyDeliveryRows, commerceDeliveryRows, latestPatrol] = await Promise.all([
      readAll(db, "newfind_promotion_deliveries", "listing_id,status,ack_status,attempts,last_error,updated_at", "listing_id", (q) => q),
      readAll(db, "commerce_events", "entity_id,status,ack_status:detail->>ackStatus,attempts:detail->>attempts,last_error:detail->>lastError,updated_at:detail->>lastAttemptAt,created_at", "id", (q) => q.eq("event_type", "newfind_commerce_delivery")),
      db.from("cron_runs").select("started_at,status,actions:metadata->actions").eq("job_name", "patrol-ai").not("finished_at", "is", null)
        .order("started_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    const patrolActions = Array.isArray(latestPatrol.data?.actions) ? latestPatrol.data.actions as Array<Record<string, unknown>> : [];
    const latestPatrolNewfind = {
      startedAt: latestPatrol.data?.started_at ?? null,
      status: latestPatrol.data?.status ?? null,
      readError: latestPatrol.error?.message ?? null,
      actions: patrolActions.filter((action) => String(action.action ?? "").startsWith("newfind")),
    };
    const newfindSummary = (rows: Array<Record<string, unknown>>) => {
      const recent = rows.filter((row) => String(row.updated_at ?? row.created_at ?? "") >= freshSince);
      return {
        allTime: tallyNewfindDeliveries(rows),
        last24Hours: tallyNewfindDeliveries(recent),
        retried: rows.filter((row) => Number(row.attempts) > 1).length,
        lastAttemptAt: rows.map((row) => String(row.updated_at ?? "")).filter(Boolean).sort().at(-1) ?? null,
        failureReasons: tally(rows.filter((row) => newfindDeliveryOutcome(row) === "failed"), "status", "last_error"),
      };
    };
    if (failedCronRows.error) throw new Error("cron_runs_failed_read_failed:" + failedCronRows.error.message);
    if (listingErrorRows.error) throw new Error("channel_listings_error_read_failed:" + listingErrorRows.error.message);
    if (supplierOfferErrorRows.error) throw new Error("supplier_offer_error_read_failed:" + supplierOfferErrorRows.error.message);
    const tally = (rows: Array<Record<string, unknown>>, group: string, reason: string) => {
      const counts = new Map<string, { [key: string]: unknown; count: number }>();
      for (const row of rows) {
        const groupValue = String(row[group] ?? "unknown");
        const reasonValue = String(row[reason] ?? "none").replace(/\s+/g, " ").slice(0, 120);
        const key = groupValue + "\u0000" + reasonValue;
        const entry = counts.get(key) ?? { [group]: groupValue, reason: reasonValue, count: 0 };
        entry.count += 1;
        counts.set(key, entry);
      }
      return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 30);
    };
    const legacyNewfind = newfindSummary(legacyDeliveryRows);
    const commerceNewfind = newfindSummary(commerceDeliveryRows);
    const newfindLegacyProcessed = legacyNewfind.allTime.delivered;
    const newfindCommerceProcessed = commerceNewfind.allTime.delivered;
    const newfindLegacyFailed = legacyNewfind.allTime.failed;
    const newfindCommerceFailed = commerceNewfind.allTime.failed;
    const newfindLegacyOpen = legacyNewfind.allTime.open + legacyNewfind.allTime.status_without_ack;
    const newfindCommerceOpen = commerceNewfind.allTime.open + commerceNewfind.allTime.status_without_ack;
    const latestCronByJob = new Map<string, Record<string, unknown>>();
    for (const row of recentCronRows.data ?? []) {
      const jobName = typeof row.job_name === "string" ? row.job_name : "unknown";
      if (!latestCronByJob.has(jobName)) latestCronByJob.set(jobName, {
        jobName, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at,
        processed: row.processed ?? 0, failed: row.failed ?? 0,
      });
    }
    const [
      products, activeProducts, variants, legacyProducts, legacyCjIdentityProducts,
      offersDiscovered, offersVerified, offersUnavailable, offersError, cjFreshOrderable,
      prices, profitablePrices,
      baseTotal, basePublished, basePending, baseHidden, baseError, baseWithoutExternalId, baseLastSynced,
      shopifyTotal, shopifyPublished, shopifyPending, shopifyHidden, shopifyError, shopifyWithoutExternalId, shopifyLastSynced,
      baseOrders, basePaid, baseShipped, baseLastOrder,
      shopifyOrders, shopifyPaid, shopifyShipped, shopifyLastOrder,
      procurementPending, procurementProcessing, procurementSubmitted, procurementConfirmed, procurementShipped, procurementFailed, procurementCancelled,
      procurementWithTracking, procurementLastSubmitted, procurementLastShipped,
      lastOfferCheck, lastPriceCalculation, approvalRequested, approvalGranted, baseUnmappedOrderItems,
      legacyListings, legacyPublished,
    ] = await Promise.all([
      count(db, "commerce_products"), count(db, "commerce_products", q => q.eq("active", true)), count(db, "commerce_variants"),
      count(db, "products"), count(db, "products", q => q.like("identity_key", "cj:product:%:variant:%")),
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
      count(db, "commerce_events", q => q.eq("event_type", "base_order_unmapped_item").eq("status", "needs_review")),
      count(db, "shop_listings"), count(db, "shop_listings", q => q.eq("published", true)),
    ]);

    return NextResponse.json({
      ok: baseLive.ok && shopifyLive.ok, readOnly: true, generatedAt: new Date().toISOString(),
      catalog: { products, activeProducts, variants },
      legacyCatalog: { products: legacyProducts, nativeCjProductVariantIdentities: legacyCjIdentityProducts },
      supplierOffers: { discovered: offersDiscovered, verified: offersVerified, unavailable: offersUnavailable, error: offersError, cjFreshOrderable, lastCheckedAt: lastOfferCheck },
      prices: { total: prices, profitableJpy: profitablePrices, lastCalculatedAt: lastPriceCalculation },
      channels: {
        base: { total: baseTotal, published: basePublished, pending: basePending, hidden: baseHidden, error: baseError, withoutExternalId: baseWithoutExternalId, lastSyncedAt: baseLastSynced },
        shopify: { total: shopifyTotal, published: shopifyPublished, pending: shopifyPending, hidden: shopifyHidden, error: shopifyError, withoutExternalId: shopifyWithoutExternalId, lastSyncedAt: shopifyLastSynced },
        legacyBase: { shopListings: legacyListings, published: legacyPublished },
      },
      livePlatforms: { base: baseLive, shopify: shopifyLive },
      orders: {
        base: { total: baseOrders, paid: basePaid, shipped: baseShipped, lastReceivedAt: baseLastOrder, unmappedItemsNeedingReview: baseUnmappedOrderItems },
        shopify: { total: shopifyOrders, paid: shopifyPaid, shipped: shopifyShipped, lastReceivedAt: shopifyLastOrder },
      },
      procurement: {
        pending: procurementPending, processing: procurementProcessing, submitted: procurementSubmitted,
        confirmed: procurementConfirmed, shipped: procurementShipped, failed: procurementFailed,
        cancelled: procurementCancelled, withTracking: procurementWithTracking,
        lastSubmittedAt: procurementLastSubmitted, lastShippedAt: procurementLastShipped,
        approvalRequired: isProcurementApprovalRequired(),
      },
      newfind: {
        acknowledged: newfindLegacyProcessed + newfindCommerceProcessed,
        failed: newfindLegacyFailed + newfindCommerceFailed,
        open: newfindLegacyOpen + newfindCommerceOpen,
        rule: "acknowledged = status processed AND receiver ack processed|duplicate, counted from the rows. HTTP 200 without that ACK stays open; status_without_ack is never acknowledged.",
        legacyShopListings: { table: "newfind_promotion_deliveries", ...legacyNewfind },
        commerceVariants: { table: "commerce_events", eventType: "newfind_commerce_delivery", ...commerceNewfind },
        latestPatrol: latestPatrolNewfind,
      },
      approvalEvents: { requested: approvalRequested, approved: approvalGranted },
      cronRuns: { last24Hours: cronRunTotal, failedLast24Hours: cronRunFailures, latestByJob: [...latestCronByJob.values()], failuresByJobAndError: tally(failedCronRows.data ?? [], "job_name", "error") },
      listingErrors: tally(listingErrorRows.data ?? [], "channel", "last_error"),
      supplierOfferErrors: (supplierOfferErrorRows.data ?? []).map((row) => {
        const raw = row.raw_data && typeof row.raw_data === "object" && !Array.isArray(row.raw_data) ? row.raw_data as Record<string, unknown> : {};
        const safeError = ["errorCode", "lastErrorCode", "error", "lastError", "verificationError"].map((key) => ({ key, value: raw[key] })).find((entry) => typeof entry.value === "string" && entry.value.trim());
        return {
          supplier: row.supplier_code,
          hasProductId: Boolean(row.supplier_product_id),
          hasVariantId: Boolean(row.supplier_variant_id),
          status: row.source_status,
          lastCheckedAt: row.last_checked_at,
          updatedAt: row.updated_at,
          rawDataKeys: Object.keys(raw).sort().slice(0, 40),
          errorField: safeError ? safeError.key : null,
          errorValue: safeError ? String(safeError.value).replace(/\\s+/g, " ").slice(0, 180) : null,
          nextReverifyAt: typeof raw.nextReverifyAt === "string" ? raw.nextReverifyAt : null,
        };
      }),
      listingErrorItems: (listingErrorRows.data ?? []).map((row) => {
        const variant = (Array.isArray(row.commerce_variants) ? row.commerce_variants[0] : row.commerce_variants) as Record<string, unknown> | null;
        const offers = (Array.isArray(variant?.supplier_offers) ? variant?.supplier_offers : []) as Array<Record<string, unknown>>;
        return {
          channel: row.channel, variantId: row.variant_id, externalProductId: row.external_product_id,
          sku: variant?.sku ?? null, title: variant?.title_ja ?? null,
          reason: String(row.last_error ?? "").slice(0, 160), lastSyncedAt: row.last_synced_at,
          offers: offers.map((offer) => ({ supplier: offer.supplier_code, productId: offer.supplier_product_id, variantId: offer.supplier_variant_id, status: offer.source_status, lastCheckedAt: offer.last_checked_at })),
        };
      }),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    return NextResponse.json({ ok: false, readOnly: true, error: message }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
