import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { executeLivePurchaseOrder } from "@/lib/ordering/dropship";
import { isCJAutoOrderingEnabled, isCJLiveOrderingEnabled } from "@/lib/config/env";
import { checkKillSwitch } from "@/lib/ops/kill-switch";
import { isCronAuthorized } from "@/lib/ops/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    if (!isCronAuthorized(request)) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    if (!isCJLiveOrderingEnabled() || !isCJAutoOrderingEnabled()) {
      return NextResponse.json({
        ok: true,
        enabled: false,
        reason: "CJ_LIVE_ORDERING and CJ_AUTO_ORDERING must both be 1",
        attempted: 0,
      });
    }

    const supabase = createSupabaseAdminClient();
    const { data: orders, error } = await supabase
      .from("purchase_orders")
      .select("id,product_id,status")
      .in("status", ["pending_approval", "placed"])
      .eq("fulfillment_kind", "dropship_customer_order")
      .is("supplier_order_id", null)
      .order("created_at", { ascending: true })
      .limit(10);

    if (error) throw new Error(error.message);

    const results = [];
    for (const order of orders ?? []) {
      const killSwitch = await checkKillSwitch({
        supplier: "CJdropshipping",
        productId: order.product_id ? String(order.product_id) : null,
      });
      if (killSwitch.blocked) {
        results.push({
          purchaseOrderId: String(order.id),
          attempted: false,
          succeeded: false,
          reason: "kill_switch_blocked",
        });
        continue;
      }

      results.push(await executeLivePurchaseOrder(String(order.id)));
    }

    return NextResponse.json({
      ok: true,
      enabled: true,
      attempted: results.filter((item) => item.attempted).length,
      succeeded: results.filter((item) => item.succeeded).length,
      results,
    });
  } catch (error) {
    console.error("[TRACER DROPSHIP EXECUTION CRON ERROR]", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
