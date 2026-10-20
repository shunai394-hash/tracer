import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { syncPaidShopifyOrders } from "@/lib/shopify/sync-orders";

export const runtime = "nodejs";
export const maxDuration = 120;

const SHOPIFY_ORDER_POLL_EVENT_KEY = "shopify_order_poll";

async function persistPollResult(detail: Record<string, unknown>, status: string) {
  const db = createSupabaseAdminClient();
  const { error } = await db.from("commerce_events").upsert({
    event_key: SHOPIFY_ORDER_POLL_EVENT_KEY,
    event_type: SHOPIFY_ORDER_POLL_EVENT_KEY,
    entity_type: "system",
    entity_id: "shopify-order-poll",
    status,
    detail: { ...detail, observedAt: new Date().toISOString() },
  }, { onConflict: "event_key" });
  if (error) throw new Error("shopify_order_poll_result_persist_failed:" + error.message);
}

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) {
    console.warn("[TRACER SHOPIFY ORDER POLL AUTH REJECTED]", { status: authError.status });
    return authError;
  }

  try {
    const imported = await syncPaidShopifyOrders(25);
    const errorCategories = imported.errors.map((item) => item.error.split(":")[0]).slice(0, 10);
    const summary = {
      ok: imported.failed === 0,
      configured: imported.configured,
      fetched: imported.fetched,
      imported: imported.imported,
      skipped: imported.skipped,
      failed: imported.failed,
      errorCategories,
    };
    await persistPollResult(summary, imported.failed === 0 && imported.configured ? "succeeded" : "needs_review");
    console.info("[TRACER SHOPIFY ORDER POLL]", summary);
    return NextResponse.json({
      ok: imported.failed === 0,
      phase: "canonical_shopify_order_ingestion",
      imported,
      procurement: "canonical commerce-procurement cron owns supplier submission",
    }, { status: imported.failed ? 207 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[TRACER SHOPIFY ORDER POLL FAILED]", { error: message });
    try {
      await persistPollResult({
        ok: false,
        phase: "shopify_order_ingestion",
        errorCategory: message.split(":")[0],
      }, "failed");
    } catch (persistError) {
      console.error("[TRACER SHOPIFY ORDER POLL RESULT PERSIST FAILED]", {
        error: persistError instanceof Error ? persistError.message : String(persistError),
      });
    }
    return NextResponse.json(
      { ok: false, phase: "shopify_order_ingestion", error: message },
      { status: 500 },
    );
  }
}
