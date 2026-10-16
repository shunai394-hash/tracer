import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runCJSandboxOrderLifecycle } from "@/lib/procurement/cj-adapter";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * One-shot sandbox proof for the clean commerce catalog. It never writes a real
 * commerce order and never enables live ordering; the external order is marked
 * sandbox and must be confirmed uncharged/non-fulfilling by the supplier API.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (process.env.CJ_SANDBOX_ORDER_TEST_ENABLED?.trim() !== "1") {
    return NextResponse.json({ ok: false, error: "CJ_SANDBOX_ORDER_TEST_DISABLED" }, { status: 404 });
  }

  const db = createSupabaseAdminClient();
  const { data: previous, error: previousError } = await db
    .from("commerce_events")
    .select("status,detail")
    .eq("event_type", "cj_sandbox_order_lifecycle")
    .order("created_at", { ascending: false })
    .limit(1);
  if (previousError) return NextResponse.json({ ok: false, error: "sandbox_audit_lookup_failed" }, { status: 500 });
  const last = previous?.[0];
  const lastDetail = last?.detail && typeof last.detail === "object" && !Array.isArray(last.detail)
    ? last.detail as Record<string, unknown> : {};
  if (last?.status === "succeeded") {
    return NextResponse.json({ ok: false, error: "CJ_SANDBOX_LIFECYCLE_ALREADY_VERIFIED" }, { status: 409 });
  }
  if (last?.status === "running") {
    return NextResponse.json({ ok: false, error: "CJ_SANDBOX_LIFECYCLE_ALREADY_RUNNING" }, { status: 409 });
  }
  if (typeof lastDetail.supplierOrderId === "string" && lastDetail.supplierOrderId.trim()) {
    return NextResponse.json({ ok: false, error: "CJ_SANDBOX_PREVIOUS_ORDER_MAY_EXIST_REQUIRES_MANUAL_RECONCILIATION" }, { status: 409 });
  }

  const cutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { data: offers, error: offersError } = await db
    .from("supplier_offers")
    .select("id,variant_id,supplier_code,supplier_product_id,supplier_variant_id,inventory,ship_to,tracking_supported,source_status,last_checked_at")
    .eq("supplier_code", "cj")
    .eq("source_status", "verified")
    .eq("ship_to", "JP")
    .eq("tracking_supported", true)
    .gt("inventory", 0)
    .gte("last_checked_at", cutoff)
    .order("last_checked_at", { ascending: false })
    .limit(10);
  if (offersError) return NextResponse.json({ ok: false, error: "sandbox_offer_scan_failed" }, { status: 500 });

  let selected: Record<string, unknown> | null = null;
  for (const offer of offers ?? []) {
    const { data: price, error: priceError } = await db
      .from("commerce_prices")
      .select("supplier_offer_id,expected_profit")
      .eq("variant_id", offer.variant_id)
      .maybeSingle();
    if (!priceError && price && price.supplier_offer_id === offer.id && Number(price.expected_profit) > 0) {
      selected = offer as unknown as Record<string, unknown>;
      break;
    }
  }
  if (!selected) {
    return NextResponse.json({ ok: false, error: "CJ_SANDBOX_NO_FRESH_PROFITABLE_OFFER" }, { status: 409 });
  }

  const eventKey = "cj-sandbox-core:" + String(selected.id) + ":" + Date.now();
  const baseDetail: Record<string, unknown> = {
    supplierOfferId: selected.id,
    supplierProductId: selected.supplier_product_id,
    supplierVariantId: selected.supplier_variant_id,
    sandbox: true,
    charged: false,
    realFulfillment: false,
  };
  const { error: insertError } = await db.from("commerce_events").insert({
    event_key: eventKey,
    event_type: "cj_sandbox_order_lifecycle",
    entity_type: "supplier_offer",
    entity_id: String(selected.id),
    status: "running",
    detail: baseDetail,
  });
  if (insertError) return NextResponse.json({ ok: false, error: "sandbox_audit_claim_failed" }, { status: 500 });

  let supplierOrderId: string | null = null;
  try {
    const result = await runCJSandboxOrderLifecycle({
      supplierProductId: String(selected.supplier_product_id),
      supplierVariantId: String(selected.supplier_variant_id),
      orderNumber: "TRACER-CLEAN-SANDBOX-" + Date.now(),
      quantity: 1,
      shippingCountryCode: "JP",
      shippingCountry: "Japan",
      shippingProvince: "Tokyo",
      shippingCity: "Chiyoda-ku",
      shippingAddress: "1-1 Chiyoda",
      shippingZip: "1000001",
      shippingPhone: "00000000000",
      shippingCustomerName: "TRACER SANDBOX TEST",
      email: "sandbox-test@example.invalid",
    }, async (createdOrderId) => {
      supplierOrderId = createdOrderId;
      const { error } = await db.from("commerce_events").update({
        detail: { ...baseDetail, supplierOrderId: createdOrderId, phase: "order_created" },
      }).eq("event_key", eventKey);
      if (error) throw new Error("sandbox_supplier_order_id_audit_failed");
    });

    const successDetail = {
      ...baseDetail,
      supplierOrderId: result.supplierOrderId,
      status: result.status,
      trackingNumber: result.trackingNumber,
      paymentConfirmed: result.paymentConfirmed,
      verifiedInventory: result.verifiedInventory,
      verifiedUnitCostUsd: result.verifiedUnitCostUsd,
      verifiedShippingCostUsd: result.verifiedShippingCostUsd,
      completedAt: new Date().toISOString(),
    };
    const { error: saveError } = await db.from("commerce_events")
      .update({ status: "succeeded", detail: successDetail })
      .eq("event_key", eventKey);
    if (saveError) throw new Error("sandbox_success_audit_save_failed");

    return NextResponse.json({
      ok: true,
      phase: "cj_sandbox_order_lifecycle",
      supplierOfferId: selected.id,
      supplierOrderId: result.supplierOrderId,
      status: result.status,
      trackingNumber: result.trackingNumber,
      paymentConfirmed: result.paymentConfirmed,
      sandbox: true,
      charged: false,
      realFulfillment: false,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 240) : "CJ sandbox lifecycle failed";
    const { error: auditError } = await db.from("commerce_events").update({
      status: "failed",
      detail: { ...baseDetail, supplierOrderId, error: detail, failedAt: new Date().toISOString() },
    }).eq("event_key", eventKey);
    if (auditError) console.error("[commerce-cj-sandbox] failed to persist audit result", auditError.message);
    console.error("[commerce-cj-sandbox] lifecycle failed", { supplierOfferId: selected.id, supplierOrderId, error: detail });
    return NextResponse.json({
      ok: false,
      phase: "cj_sandbox_order_lifecycle",
      supplierOfferId: selected.id,
      supplierOrderId,
      error: detail,
      sandbox: true,
      charged: false,
      realFulfillment: false,
    }, { status: 502 });
  }
}
