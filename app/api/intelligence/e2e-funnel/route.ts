import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { hasPassedSalesTestGate, SALES_TEST_GATE_PASSED } from "@/lib/market/sales-test-gate";

export const runtime = "nodejs";
export const maxDuration = 60;

type Db = ReturnType<typeof createSupabaseAdminClient>;
type Query = ReturnType<ReturnType<Db["from"]>["select"]>;

const IDENTIFIER_GRADE = ["asin", "jan", "gtin", "ean", "upc", "mpn", "brand_mpn", "tracer_catalog"];

async function count(db: Db, table: string, filter?: (q: Query) => Query): Promise<number | string> {
  const base = db.from(table).select("*", { count: "exact", head: true });
  const { count: value, error } = await (filter ? filter(base) : base);
  return error ? `error: ${error.message}` : value ?? 0;
}

function tally(values: unknown[], top = 8): Record<string, number> {
  const map = new Map<string, number>();
  for (const value of values) {
    const key = String(value ?? "null").slice(0, 120);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, top));
}

/**
 * Read-only end-to-end funnel for the autonomous loop. For every stage it
 * reports how many items reached it and how many are stalled: the previous
 * stage succeeded but the next one never happened. Sales Test Gate membership
 * is decided by provenance (hasPassedSalesTestGate), never by published=true.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  const now = Date.now();
  const staleBefore = new Date(now - 330_000).toISOString();

  // --- Market / Identity / Supply / Intelligence ---------------------------
  const [
    marketTotal,
    marketWithIdentifier,
    cjVerifiedOrderable,
    cjIdentifierGrade,
    cjSupplyDiscoveredOnly,
    oppTestReady,
    oppSelectionEligible,
  ] = await Promise.all([
    count(db, "marketplace_bestsellers"),
    count(db, "marketplace_bestsellers", (q) => q.or("jan.not.is.null,gtin.not.is.null,ean.not.is.null,upc.not.is.null")),
    count(db, "supplier_listings", (q) => q.eq("supplier", "cj").eq("verification_status", "verified").eq("orderable", true)),
    count(db, "supplier_listings", (q) => q.eq("supplier", "cj").eq("identity_status", "linked").in("identity_method", IDENTIFIER_GRADE)),
    count(db, "supplier_listings", (q) => q.eq("supplier", "cj").eq("identity_method", "supply_discovered")),
    count(db, "opportunity_intelligence", (q) => q.in("sellability_state", ["TEST_READY", "SELLABLE"])),
    count(db, "opportunity_intelligence", (q) => q.eq("selection_eligible", true)),
  ]);

  const { data: marketStages } = await db.from("marketplace_bestsellers").select("pipeline_stage,pipeline_status,pipeline_reason").order("pipeline_updated_at", { ascending: false, nullsFirst: false }).limit(1000);

  // Identity-linked, verified CJ supply whose product never got a listing.
  const { data: linkedSupply } = await db
    .from("supplier_listings")
    .select("id,product_id,identity_method")
    .eq("supplier", "cj")
    .eq("identity_status", "linked")
    .in("identity_method", IDENTIFIER_GRADE)
    .eq("verification_status", "verified")
    .limit(500);
  const linkedProductIds = Array.from(new Set((linkedSupply ?? []).map((row) => String(row.product_id ?? "")).filter(Boolean)));
  let linkedWithoutTestReady = 0;
  let testReadyWithoutListing = 0;
  if (linkedProductIds.length) {
    const [{ data: opp }, { data: listingRows }] = await Promise.all([
      db.from("opportunity_intelligence").select("product_id,sellability_state").in("product_id", linkedProductIds),
      db.from("shop_listings").select("product_id").in("product_id", linkedProductIds),
    ]);
    const ready = new Set((opp ?? []).filter((row) => ["TEST_READY", "SELLABLE"].includes(String(row.sellability_state))).map((row) => String(row.product_id)));
    const listed = new Set((listingRows ?? []).map((row) => String(row.product_id)));
    for (const id of linkedProductIds) {
      if (!ready.has(id)) linkedWithoutTestReady += 1;
      else if (!listed.has(id)) testReadyWithoutListing += 1;
    }
  }

  // --- Sales Test Gate / Shop / BASE / NEWFIND ------------------------------
  const columns = "id,title,published,base_item_id,base_publication_status,pipeline_stage,pipeline_status,pipeline_reason,selection_reasons,image_url,selling_price";
  const [byReason, byMarker] = await Promise.all([
    db.from("shop_listings").select(columns).eq("pipeline_reason", SALES_TEST_GATE_PASSED).limit(1000),
    db.from("shop_listings").select(columns).filter("selection_reasons", "cs", JSON.stringify([SALES_TEST_GATE_PASSED])).limit(1000),
  ]);
  const gateRows = new Map<string, Record<string, unknown>>();
  for (const row of [...(byReason.data ?? []), ...(byMarker.data ?? [])]) gateRows.set(String(row.id), row as Record<string, unknown>);
  const everGated = [...gateRows.values()];
  const gatePassedPublic = everGated.filter((row) => hasPassedSalesTestGate(row));
  const gatedNotOnBase = gatePassedPublic.filter((row) => !row.base_item_id);
  const gatedOnBase = gatePassedPublic.filter((row) => row.base_item_id);

  const deliveryByListing = new Map<string, Record<string, unknown>>();
  const gatedIds = gatePassedPublic.map((row) => String(row.id));
  for (let i = 0; i < gatedIds.length; i += 100) {
    const { data } = await db.from("newfind_promotion_deliveries").select("listing_id,status,ack_status,last_error,attempts").in("listing_id", gatedIds.slice(i, i + 100));
    for (const row of data ?? []) deliveryByListing.set(String(row.listing_id), row as Record<string, unknown>);
  }
  const newfindState = (id: string) => {
    const delivery = deliveryByListing.get(id);
    if (!delivery) return "missing";
    if (delivery.status === "processed" && delivery.ack_status === "processed") return "processed";
    return String(delivery.status ?? "pending");
  };
  const baseToNewfind = tally(gatedOnBase.map((row) => newfindState(String(row.id))));
  const baseNotOnNewfind = gatedOnBase
    .filter((row) => newfindState(String(row.id)) !== "processed")
    .slice(0, 20)
    .map((row) => {
      const delivery = deliveryByListing.get(String(row.id));
      return {
        listingId: row.id,
        title: row.title,
        baseItemId: row.base_item_id,
        newfind: newfindState(String(row.id)),
        attempts: delivery?.attempts ?? 0,
        lastError: delivery?.last_error ?? null,
      };
    });

  const { data: failedDeliveries } = await db.from("newfind_promotion_deliveries").select("last_error").eq("status", "failed").limit(1000);

  // --- Orders ---------------------------------------------------------------
  const { data: paidOrders } = await db.from("shop_orders").select("id").eq("payment_status", "paid").limit(1000);
  const paidIds = (paidOrders ?? []).map((row) => String(row.id));
  let paidWithoutPurchaseOrder = 0;
  if (paidIds.length) {
    const { data: pos } = await db.from("purchase_orders").select("shop_order_id").in("shop_order_id", paidIds.slice(0, 500));
    const withPo = new Set((pos ?? []).map((row) => String(row.shop_order_id)));
    paidWithoutPurchaseOrder = paidIds.filter((id) => !withPo.has(id)).length;
  }
  const [shopOrders, purchaseOrders, supplierOrders, paymentPending, paymentFailed, paymentConfirmed, placedWithoutTracking, shipped] = await Promise.all([
    count(db, "shop_orders"),
    count(db, "purchase_orders"),
    count(db, "purchase_orders", (q) => q.not("supplier_order_id", "is", null)),
    count(db, "purchase_orders", (q) => q.eq("status", "supplier_payment_pending")),
    count(db, "purchase_orders", (q) => q.eq("status", "supplier_payment_verification_failed")),
    count(db, "purchase_orders", (q) => q.eq("supplier_status", "paid")),
    count(db, "purchase_orders", (q) => q.eq("status", "placed").is("tracking_number", null)),
    count(db, "purchase_orders", (q) => q.in("status", ["shipped", "delivered"])),
  ]);

  // --- Cron health ----------------------------------------------------------
  const { data: running } = await db.from("cron_runs").select("job_name,started_at").eq("status", "running").limit(200);
  const stale = (running ?? []).filter((row) => String(row.started_at) < staleBefore);
  const { data: recentPatrols } = await db
    .from("cron_runs")
    .select("status,started_at,duration_ms,error")
    .eq("job_name", "patrol-ai")
    .order("started_at", { ascending: false })
    .limit(10);

  return NextResponse.json({
    ok: true,
    generatedAt: new Date(now).toISOString(),
    deployment: { commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null },
    stages: {
      market: { bestsellers: marketTotal, withBarcodeIdentifier: marketWithIdentifier, pipeline: tally((marketStages ?? []).map((r) => `${r.pipeline_stage}:${r.pipeline_status}`)), topReasons: tally((marketStages ?? []).map((r) => r.pipeline_reason)) },
      identity: { cjIdentifierGradeLinked: cjIdentifierGrade, cjSupplyDiscoveredOnly },
      supply: { cjVerifiedOrderable },
      intelligence: { testReadyOrSellable: oppTestReady, selectionEligible: oppSelectionEligible },
      salesTestGate: { everPassed: everGated.length, passedAndPublic: gatePassedPublic.length },
      shop: { gatePassedPublic: gatePassedPublic.length },
      base: { gatePassedOnBase: gatedOnBase.length },
      newfind: { gatePassedOnBaseByDelivery: baseToNewfind, failedReasons: tally((failedDeliveries ?? []).map((r) => r.last_error)) },
      orders: { shopOrders, purchaseOrders, supplierOrders, supplierPaymentPending: paymentPending, supplierPaymentVerificationFailed: paymentFailed, supplierPaymentConfirmed: paymentConfirmed, shippedOrDelivered: shipped },
    },
    stalls: {
      identityLinkedSupplyNotTestReady: linkedWithoutTestReady,
      testReadyLinkedSupplyWithoutListing: testReadyWithoutListing,
      gatePassedPublicNotOnBase: gatedNotOnBase.length,
      gatePassedOnBaseNotProcessedByNewfind: gatedOnBase.length - (baseToNewfind.processed ?? 0),
      paidOrdersWithoutPurchaseOrder: paidWithoutPurchaseOrder,
      placedSupplierOrdersWithoutTracking: placedWithoutTracking,
      baseNotOnNewfindSamples: baseNotOnNewfind,
    },
    cron: {
      running: (running ?? []).length,
      stale: stale.length,
      staleJobs: tally(stale.map((row) => row.job_name)),
      recentPatrols: recentPatrols ?? [],
    },
  });
}
