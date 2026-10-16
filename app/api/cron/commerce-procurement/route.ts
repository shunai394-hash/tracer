import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { cjSupplierAdapter } from "@/lib/procurement/cj-adapter";
import type { SupplierOrderInput } from "@/lib/procurement/types";

export const runtime = "nodejs";
export const maxDuration = 300;

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function str(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}
function customerName(order: Record<string, unknown>, address: Record<string, unknown>): string {
  const full = str(order, "customer_name", "name");
  if (full) return full;
  return [str(address, "first_name", "firstName"), str(address, "last_name", "lastName")].filter(Boolean).join(" ");
}
function buildInput(row: Record<string, unknown>, line: Record<string, unknown>, order: Record<string, unknown>, address: Record<string, unknown>): SupplierOrderInput {
  const countryCode = str(address, "country_code", "countryCode", "country_code_v2").toUpperCase();
  const name = customerName(order, address);
  return {
    supplierName: "cj",
    orderNumber: "TRACER-PO-" + String(row.id),
    supplierProductId: String(row.supplier_product_id ?? ""),
    supplierVariantId: String(row.supplier_variant_id ?? ""),
    quantity: Number(row.quantity),
    shippingCountryCode: countryCode,
    shippingCountry: str(address, "country", "country_name") || (countryCode === "JP" ? "Japan" : ""),
    shippingProvince: str(address, "province", "province_code", "prefecture"),
    shippingCity: str(address, "city"),
    shippingAddress: str(address, "address1", "address", "street"),
    shippingAddress2: str(address, "address2", "address2_line"),
    shippingZip: str(address, "zip", "zip_code", "postal_code"),
    shippingPhone: str(address, "phone", "tel"),
    shippingCustomerName: name,
    email: str(address, "email") || str(order, "email"),
  };
}

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  const db = createSupabaseAdminClient();
  const result = { checked: 0, submitted: 0, confirmed: 0, shipped: 0, failed: 0, blocked: 0, stuckProcessing: 0, errors: [] as string[] };

  // Poll existing supplier orders first; never submit an order twice to obtain tracking.
  const { data: active, error: activeError } = await db.from("procurement_orders")
    .select("id,external_order_id,status,commerce_order_lines!inner(commerce_orders!inner(id,fulfillment_status))")
    .eq("supplier_code", "cj").in("status", ["submitted", "confirmed"]).not("external_order_id", "is", null).limit(25);
  if (activeError) return NextResponse.json({ ok: false, error: "procurement_poll_read_failed:" + activeError.message }, { status: 500 });
  for (const item of active ?? []) {
    result.checked++;
    try {
      const externalId = String(item.external_order_id ?? "");
      if (!externalId) continue;
      const status = await cjSupplierAdapter.getOrderStatus(externalId);
      if (status?.paymentConfirmed && item.status === "submitted") {
        const { error } = await db.from("procurement_orders").update({ status: "confirmed", updated_at: new Date().toISOString(), last_error: null }).eq("id", item.id).eq("status", "submitted");
        if (error) throw new Error("supplier_confirmation_save_failed:" + error.message);
        result.confirmed++;
      }
      const tracking = await cjSupplierAdapter.getTracking(externalId);
      if (tracking?.trackingNumber) {
        const { error } = await db.from("procurement_orders").update({
          status: "shipped", tracking_number: tracking.trackingNumber, tracking_url: tracking.trackingUrl,
          shipped_at: tracking.shippedAt || new Date().toISOString(), updated_at: new Date().toISOString(), last_error: null
        }).eq("id", item.id).in("status", ["submitted", "confirmed"]);
        if (error) throw new Error("tracking_save_failed:" + error.message);
        result.shipped++;
        const nested = item.commerce_order_lines as unknown;
        const orderLine = Array.isArray(nested) ? obj(nested[0]) : obj(nested);
        const commerceOrders = orderLine.commerce_orders as unknown;
        const order = Array.isArray(commerceOrders) ? obj(commerceOrders[0]) : obj(commerceOrders);
        if (order.id) await db.from("commerce_orders").update({ fulfillment_status: "shipped", updated_at: new Date().toISOString() }).eq("id", order.id);
      }
    } catch (error) {
      result.failed++;
      result.errors.push(String(item.id) + ":" + (error instanceof Error ? error.message : String(error)).slice(0, 160));
    }
  }

  const { data: stale, error: staleError } = await db.from("procurement_orders").select("id").eq("supplier_code", "cj").eq("status", "processing").limit(25);
  if (staleError) result.errors.push("processing_state_read_failed:" + staleError.message);
  result.stuckProcessing = stale?.length ?? 0;

  // Do not create supplier orders unless the existing, explicit payment-flow and live-order controls are enabled.
  if (!cjSupplierAdapter.capabilities.liveOrdering) {
    return NextResponse.json({ ok: result.failed === 0, ...result, submission: "disabled_until_live_order_and_payment_flow_are_verified" }, { status: 200 });
  }

  const { data: pending, error: pendingError } = await db.from("procurement_orders")
    .select("id,supplier_code,supplier_product_id,supplier_variant_id,quantity,status,commerce_order_lines!inner(id,variant_id,supplier_offer_id,quantity,commerce_orders!inner(id,external_order_id,payment_status,customer_name,shipping_address,raw_payload))")
    .eq("supplier_code", "cj").eq("status", "pending").limit(10);
  if (pendingError) return NextResponse.json({ ok: false, ...result, error: "procurement_pending_read_failed:" + pendingError.message }, { status: 500 });

  for (const rowValue of pending ?? []) {
    const row = obj(rowValue);
    result.checked++;
    const nestedLine = row.commerce_order_lines as unknown;
    const line = Array.isArray(nestedLine) ? obj(nestedLine[0]) : obj(nestedLine);
    const nestedOrder = line.commerce_orders as unknown;
    const order = Array.isArray(nestedOrder) ? obj(nestedOrder[0]) : obj(nestedOrder);
    if (order.payment_status !== "paid") { result.blocked++; continue; }
    const address = obj(order.shipping_address);
    const input = buildInput(row, line, order, address);
    const required = [input.supplierProductId, input.supplierVariantId, input.shippingCountryCode, input.shippingProvince, input.shippingCity, input.shippingAddress, input.shippingZip, input.shippingPhone, input.shippingCustomerName];
    if (required.some((value) => !String(value ?? "").trim()) || !Number.isSafeInteger(input.quantity) || input.quantity < 1) {
      result.blocked++;
      result.errors.push(String(row.id) + ":shipping_address_or_line_incomplete");
      continue;
    }

    // Recheck the exact offer and its stored profitable price immediately before
    // any external order call. A paid webhook may have been delayed or retried.
    const offerId = str(line, "supplier_offer_id");
    const variantId = str(line, "variant_id");
    if (!offerId || !variantId || str(line, "id") === "") {
      result.blocked++;
      result.errors.push(String(row.id) + ":canonical_order_line_mapping_missing");
      continue;
    }
    const { data: offer, error: offerError } = await db.from("supplier_offers")
      .select("id,variant_id,supplier_code,supplier_product_id,supplier_variant_id,inventory,ship_to,tracking_supported,source_status,last_checked_at")
      .eq("id", offerId).eq("variant_id", variantId).maybeSingle();
    const checkedAt = typeof offer?.last_checked_at === "string" ? Date.parse(offer.last_checked_at) : Number.NaN;
    if (offerError || !offer ||
      offer.supplier_code !== "cj" ||
      offer.supplier_product_id !== row.supplier_product_id ||
      offer.supplier_variant_id !== row.supplier_variant_id ||
      offer.source_status !== "verified" || offer.tracking_supported !== true ||
      offer.ship_to !== "JP" || Number(offer.inventory) < input.quantity ||
      !Number.isFinite(checkedAt) || checkedAt > Date.now() + 5 * 60_000 || Date.now() - checkedAt > 24 * 60 * 60_000) {
      result.blocked++;
      result.errors.push(String(row.id) + ":supplier_offer_not_fresh_and_fulfillable");
      continue;
    }
    const { data: price, error: priceError } = await db.from("commerce_prices")
      .select("supplier_offer_id,expected_profit").eq("variant_id", variantId).maybeSingle();
    if (priceError || !price || price.supplier_offer_id !== offerId || Number(price.expected_profit) <= 0) {
      result.blocked++;
      result.errors.push(String(row.id) + ":exact_supplier_offer_price_missing_or_unprofitable");
      continue;
    }

    const { data: claim, error: claimError } = await db.from("procurement_orders")
      .update({ status: "processing", updated_at: new Date().toISOString(), last_error: null })
      .eq("id", row.id).eq("status", "pending").select("id").maybeSingle();
    if (claimError) { result.failed++; result.errors.push(String(row.id) + ":claim_failed:" + claimError.message); continue; }
    if (!claim) continue;
    let createdSupplierOrderId: string | null = null;
    try {
      const validation = await cjSupplierAdapter.validateOrderInput?.(input);
      if (!validation?.valid) throw new Error(validation?.responseCode + ":" + (validation?.responseMessage ?? "supplier_preflight_missing"));
      const created = await cjSupplierAdapter.createOrder(input);
      if (!created.succeeded || !created.supplierOrderId) throw new Error(created.responseCode + ":" + (created.responseMessage ?? "supplier_order_not_confirmed"));
      createdSupplierOrderId = created.supplierOrderId;
      const { error: saveError } = await db.from("procurement_orders").update({
        status: "submitted", external_order_id: created.supplierOrderId, submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(), last_error: null
      }).eq("id", row.id).eq("status", "processing");
      if (saveError) throw new Error("supplier_order_id_save_failed:" + saveError.message);
      await db.from("commerce_orders").update({ fulfillment_status: "ordered", updated_at: new Date().toISOString() }).eq("id", order.id);
      result.submitted++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (createdSupplierOrderId) {
        // Once CJ has returned an order ID, never downgrade to retryable/failed:
        // repair the local state or leave "processing" for manual reconciliation.
        const { error: repairError } = await db.from("procurement_orders").update({
          status: "submitted", external_order_id: createdSupplierOrderId,
          submitted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          last_error: "post_create_state_repair:" + message.slice(0, 1000)
        }).eq("id", row.id).eq("status", "processing");
        result.failed++;
        result.errors.push(String(row.id) + (repairError
          ? ":supplier_order_created_but_state_repair_failed_leave_processing"
          : ":supplier_order_created_state_repaired_check_order_status"));
      } else {
        await db.from("procurement_orders").update({ status: "failed", last_error: message.slice(0, 1500), updated_at: new Date().toISOString() }).eq("id", row.id).eq("status", "processing");
        result.failed++;
        result.errors.push(String(row.id) + ":" + message.slice(0, 160));
      }
    }
  }
  return NextResponse.json({ ok: result.failed === 0, ...result }, { status: result.failed ? 207 : 200 });
}
