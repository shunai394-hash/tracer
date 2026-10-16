import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { confirmPurchaseOrderForLiveExecution } from "@/lib/ordering/dropship";
import {
  PROCUREMENT_APPROVAL_EVENT_TYPE,
  buildProcurementApprovalDetail,
  isProcurementApprovalRequired,
  procurementApprovalEventKey,
} from "@/lib/commerce/procurement-approval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function first(value: unknown): Record<string, unknown> {
  return Array.isArray(value) ? obj(value[0]) : obj(value);
}

/**
 * Summary a person needs to approve one canonical procurement row: supplier
 * IDs, quantity, supplier cost and freight, selling price and expected profit,
 * and the destination country/prefecture. No customer name, street or phone.
 */
async function procurementSummary(id: string) {
  const db = createSupabaseAdminClient();
  const { data, error } = await db.from("procurement_orders")
    .select("id,status,supplier_code,supplier_product_id,supplier_variant_id,quantity,external_order_id,last_error,created_at,commerce_order_lines!inner(variant_id,supplier_offer_id,unit_price,commerce_orders!inner(channel,external_order_id,payment_status,total_amount,shipping_address))")
    .eq("id", id).maybeSingle();
  if (error) throw new Error("procurement_read_failed:" + error.message);
  if (!data) return null;
  const line = first(data.commerce_order_lines);
  const order = first(line.commerce_orders);
  const address = obj(order.shipping_address);
  const offerId = typeof line.supplier_offer_id === "string" ? line.supplier_offer_id : "";
  const variantId = typeof line.variant_id === "string" ? line.variant_id : "";
  const [{ data: offer }, { data: price }, { data: approval }] = await Promise.all([
    db.from("supplier_offers").select("currency,unit_cost,shipping_cost,inventory,ship_to,source_status,tracking_supported,last_checked_at,supplier_url").eq("id", offerId).maybeSingle(),
    db.from("commerce_prices").select("selling_price,expected_profit,fee_amount,currency").eq("variant_id", variantId).maybeSingle(),
    db.from("commerce_events").select("detail,created_at").eq("event_key", procurementApprovalEventKey(id)).maybeSingle(),
  ]);
  return {
    kind: "procurement" as const,
    id: data.id,
    status: data.status,
    supplier: { code: data.supplier_code, productId: data.supplier_product_id, variantId: data.supplier_variant_id, url: offer?.supplier_url ?? null },
    quantity: data.quantity,
    customerOrder: { channel: order.channel ?? null, externalOrderId: order.external_order_id ?? null, paymentStatus: order.payment_status ?? null, totalAmountJpy: order.total_amount ?? null, unitPriceJpy: line.unit_price ?? null },
    supplierOffer: offer ?? null,
    price: price ?? null,
    destination: { countryCode: address.country_code ?? address.countryCode ?? null, province: address.province ?? address.prefecture ?? null },
    supplierOrderId: data.external_order_id,
    lastError: data.last_error,
    approval: approval ?? null,
  };
}

/** GET: pending procurement rows and legacy purchase orders that still need a person's approval. */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  try {
    const db = createSupabaseAdminClient();
    const [{ data: pending, error: pendingError }, { data: legacy, error: legacyError }] = await Promise.all([
      db.from("procurement_orders").select("id").eq("status", "pending").order("created_at", { ascending: true }).limit(50),
      db.from("purchase_orders").select("id,supplier_name,supplier_product_id,supplier_variant_id,qty,status,fulfillment_kind,created_at")
        .is("human_confirmed_at", null).is("supplier_order_id", null).order("created_at", { ascending: true }).limit(50),
    ]);
    if (pendingError) throw new Error("procurement_pending_read_failed:" + pendingError.message);
    if (legacyError) throw new Error("purchase_orders_read_failed:" + legacyError.message);
    const procurement = [];
    for (const row of pending ?? []) procurement.push(await procurementSummary(String(row.id)));
    return NextResponse.json({
      ok: true,
      approvalRequired: isProcurementApprovalRequired(),
      procurement,
      legacyPurchaseOrders: legacy ?? [],
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message.slice(0, 300) : String(error) }, { status: 500 });
  }
}

/**
 * POST { kind: "procurement" | "purchase_order", id, approvedBy, apply?: boolean }
 * - apply false (default): returns what would be approved; writes nothing.
 * - apply true: records the approval only. It never calls the supplier; the
 *   next scheduled run re-checks stock, freight and profit before ordering.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  let body: { kind?: unknown; id?: unknown; approvedBy?: unknown; apply?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const kind = body.kind === "purchase_order" ? "purchase_order" : body.kind === "procurement" ? "procurement" : null;
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const approvedBy = typeof body.approvedBy === "string" ? body.approvedBy.trim().slice(0, 120) : "";
  if (!kind) return NextResponse.json({ ok: false, error: "kind_required" }, { status: 400 });
  if (!UUID.test(id)) return NextResponse.json({ ok: false, error: "id_required" }, { status: 400 });
  if (!approvedBy) return NextResponse.json({ ok: false, error: "approved_by_required" }, { status: 400 });
  const apply = body.apply === true;

  try {
    if (kind === "purchase_order") {
      const db = createSupabaseAdminClient();
      const { data: po, error } = await db.from("purchase_orders")
        .select("id,supplier_name,supplier_product_id,supplier_variant_id,qty,status,fulfillment_kind,human_confirmed_at,supplier_order_id")
        .eq("id", id).maybeSingle();
      if (error) throw new Error("purchase_order_read_failed:" + error.message);
      if (!po) return NextResponse.json({ ok: false, error: "purchase_order_not_found" }, { status: 404 });
      if (!apply) return NextResponse.json({ ok: true, apply: false, purchaseOrder: po });
      const confirmed = await confirmPurchaseOrderForLiveExecution({ purchaseOrderId: id, confirmedBy: approvedBy });
      return NextResponse.json({ ok: confirmed.confirmed, apply: true, ...confirmed }, { status: confirmed.confirmed ? 200 : 409 });
    }

    const summary = await procurementSummary(id);
    if (!summary) return NextResponse.json({ ok: false, error: "procurement_order_not_found" }, { status: 404 });
    if (summary.status !== "pending") return NextResponse.json({ ok: false, error: "procurement_order_not_pending", summary }, { status: 409 });
    if (!apply) return NextResponse.json({ ok: true, apply: false, summary });

    const detail = buildProcurementApprovalDetail({
      id,
      supplierCode: String(summary.supplier.code ?? ""),
      supplierProductId: String(summary.supplier.productId ?? ""),
      supplierVariantId: String(summary.supplier.variantId ?? ""),
      quantity: Number(summary.quantity),
    }, approvedBy);
    const db = createSupabaseAdminClient();
    const { error } = await db.from("commerce_events").upsert({
      event_key: procurementApprovalEventKey(id),
      event_type: PROCUREMENT_APPROVAL_EVENT_TYPE,
      entity_type: "procurement_order",
      entity_id: id,
      status: "ok",
      detail,
    }, { onConflict: "event_key" });
    if (error) throw new Error("approval_save_failed:" + error.message);
    return NextResponse.json({ ok: true, apply: true, approval: detail });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message.slice(0, 300) : String(error) }, { status: 500 });
  }
}
