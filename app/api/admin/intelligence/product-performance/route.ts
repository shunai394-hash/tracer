import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Listing = {
  id: string;
  title: string;
  selling_price: number | string | null;
  contribution_profit: number | string | null;
  contribution_margin: number | string | null;
  published: boolean;
  pipeline_status: string | null;
  created_at: string;
};

function amount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read-only listing performance report. It deliberately does not auto-remove
 * products: a listing needs a minimum exposure sample and confirmed paid-order
 * evidence before a replacement decision can be recommended.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const db = createSupabaseAdminClient();
    const [listingsResult, funnelResult, itemsResult, ordersResult] = await Promise.all([
      db.from("shop_listings")
        .select("id,title,selling_price,contribution_profit,contribution_margin,published,pipeline_status,created_at")
        .order("created_at", { ascending: false })
        .limit(2000),
      db.from("shop_funnel_events")
        .select("listing_id,event_type,qty,created_at")
        .limit(20000),
      db.from("shop_order_items")
        .select("order_id,listing_id,qty,unit_price,title")
        .limit(10000),
      db.from("shop_orders")
        .select("id,payment_status,refund_amount,refunded_at,created_at")
        .limit(10000),
    ]);
    for (const result of [listingsResult, funnelResult, itemsResult, ordersResult]) {
      if (result.error) throw new Error(result.error.message);
    }

    const paidOrders = new Map((ordersResult.data ?? [])
      .filter((order) => String(order.payment_status ?? "").toLowerCase() === "paid")
      .map((order) => [String(order.id), order]));
    const metrics = new Map<string, {
      views: number; addToCart: number; checkoutStarted: number; paidOrders: Set<string>;
      units: number; grossRevenue: number; refunds: number; refundedOrders: number;
    }>();
    const get = (id: string) => {
      let value = metrics.get(id);
      if (!value) {
        value = { views: 0, addToCart: 0, checkoutStarted: 0, paidOrders: new Set(), units: 0, grossRevenue: 0, refunds: 0, refundedOrders: 0 };
        metrics.set(id, value);
      }
      return value;
    };

    for (const event of funnelResult.data ?? []) {
      const id = String(event.listing_id ?? "");
      if (!id) continue;
      const value = get(id);
      const type = String(event.event_type ?? "").toLowerCase();
      const qty = Math.max(1, amount(event.qty));
      if (["view", "product_view", "view_item", "impression"].includes(type)) value.views += qty;
      if (["add_to_cart", "cart_add"].includes(type)) value.addToCart += qty;
      if (["checkout_started", "begin_checkout"].includes(type)) value.checkoutStarted += qty;
    }

    for (const item of itemsResult.data ?? []) {
      const order = paidOrders.get(String(item.order_id ?? ""));
      const listingId = String(item.listing_id ?? "");
      if (!order || !listingId) continue;
      const value = get(listingId);
      value.paidOrders.add(String(item.order_id));
      const qty = Math.max(0, amount(item.qty));
      value.units += qty;
      value.grossRevenue += qty * amount(item.unit_price);
      const refund = amount(order.refund_amount);
      if (refund > 0 && !value.paidOrders.has("refund-counted:" + String(item.order_id))) {
        value.refunds += refund;
        value.refundedOrders += 1;
        value.paidOrders.add("refund-counted:" + String(item.order_id));
      }
    }

    const products = (listingsResult.data ?? []).map((listing: Listing) => {
      const m = get(String(listing.id));
      const paidOrderCount = [...m.paidOrders].filter((id) => !id.startsWith("refund-counted:")).length;
      const conversionRate = m.views > 0 ? paidOrderCount / m.views : null;
      const refundRate = paidOrderCount > 0 ? m.refundedOrders / paidOrderCount : null;
      const estimatedContributionProfit = m.units * amount(listing.contribution_profit);
      const enoughExposure = m.views >= 100;
      const replaceCandidate = enoughExposure && (
        paidOrderCount === 0 ||
        (conversionRate !== null && conversionRate < 0.01) ||
        (refundRate !== null && refundRate > 0.05)
      );
      return {
        listingId: String(listing.id),
        title: listing.title,
        published: listing.published === true,
        pipelineStatus: listing.pipeline_status,
        sellingPrice: amount(listing.selling_price),
        expectedContributionProfitPerUnit: amount(listing.contribution_profit),
        expectedContributionMarginPct: amount(listing.contribution_margin),
        views: m.views,
        addToCart: m.addToCart,
        checkoutStarted: m.checkoutStarted,
        paidOrders: paidOrderCount,
        units: m.units,
        grossRevenue: Math.round(m.grossRevenue * 100) / 100,
        recordedRefunds: Math.round(m.refunds * 100) / 100,
        refundRate,
        observedPaidOrderPerViewRate: conversionRate,
        estimatedContributionProfit: Math.round(estimatedContributionProfit * 100) / 100,
        replacementReview: replaceCandidate ? "review_for_replacement" : enoughExposure ? "keep_or_gather_more_evidence" : "insufficient_exposure",
      };
    });

    const totalViews = products.reduce((sum, p) => sum + p.views, 0);
    const totalPaidOrders = products.reduce((sum, p) => sum + p.paidOrders, 0);
    return NextResponse.json({
      ok: true,
      readOnly: true,
      generatedAt: new Date().toISOString(),
      note: "No product is automatically removed. Replacement review requires at least 100 tracked views; conversion and refund metrics are unavailable when source events are not recorded.",
      summary: {
        listings: products.length,
        publishedListings: products.filter((p) => p.published).length,
        trackedViews: totalViews,
        paidOrders: totalPaidOrders,
        grossRevenue: Math.round(products.reduce((sum, p) => sum + p.grossRevenue, 0) * 100) / 100,
        recordedRefunds: Math.round(products.reduce((sum, p) => sum + p.recordedRefunds, 0) * 100) / 100,
        listingsWithEnoughExposure: products.filter((p) => p.views >= 100).length,
        replacementReviewCandidates: products.filter((p) => p.replacementReview === "review_for_replacement").length,
      },
      products,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 300) : "PRODUCT_PERFORMANCE_REPORT_FAILED",
    }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
