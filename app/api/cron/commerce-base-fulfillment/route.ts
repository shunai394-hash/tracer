import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getBaseOrderDetail, isBaseConfigured, listBaseDeliveryCompanies, updateBaseOrderItemFulfillment } from "@/lib/channels/base";

export const runtime = "nodejs";
export const maxDuration = 120;

type Row = Record<string, unknown>;
function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}
function afterpayPayment(value: unknown): boolean {
  return ["bnpl", "bnpl_installment", "atobarai"].includes(String(value ?? "").toLowerCase());
}

/** Reflect supplier tracking into BASE for paid canonical orders, idempotently per order line + tracking number. */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (!isBaseConfigured()) return NextResponse.json({ ok: false, error: "base_oauth_not_configured" }, { status: 503 });

  const db = createSupabaseAdminClient();
  const result = { checked: 0, synced: 0, skipped: 0, blocked: 0, failed: 0, errors: [] as string[] };
  const { data: orders, error } = await db.from("commerce_orders")
    .select("id,external_order_id,payment_status,fulfillment_status,raw_payload,commerce_order_lines(id,external_line_id,quantity,procurement_orders(id,status,tracking_number,tracking_url,shipped_at))")
    .eq("channel", "base")
    .eq("payment_status", "paid")
    .eq("fulfillment_status", "shipped")
    .not("external_order_id", "is", null)
    .order("updated_at", { ascending: true })
    .limit(25);
  if (error) return NextResponse.json({ ok: false, error: "base_fulfillment_read_failed:" + error.message }, { status: 500 });

  let deliveryCompanies: Awaited<ReturnType<typeof listBaseDeliveryCompanies>> | null = null;
  for (const orderValue of orders ?? []) {
    result.checked++;
    const order = record(orderValue);
    const orderId = String(order.id ?? "");
    const externalOrderId = String(order.external_order_id ?? "").trim();
    const rawPayload = record(order.raw_payload);
    const afterpay = afterpayPayment(rawPayload.payment);
    const synced = array(rawPayload.tracerBaseFulfillmentGroups).map(record);
    let orderPayloadChanged = false;

    for (const lineValue of array(order.commerce_order_lines)) {
      const line = record(lineValue);
      const externalLineId = String(line.external_line_id ?? "").trim();
      if (!externalLineId || !/^\d+$/.test(externalLineId)) {
        result.blocked++;
        result.errors.push(orderId + ":base_order_item_id_missing_or_invalid");
        continue;
      }
      for (const procurementValue of array(line.procurement_orders)) {
        const procurement = record(procurementValue);
        const trackingNumber = String(procurement.tracking_number ?? "").trim();
        if (procurement.status !== "shipped" || !trackingNumber) continue;
        const key = externalLineId + "|" + trackingNumber;
        if (synced.some((item) => item.key === key && typeof item.syncedAt === "string")) {
          result.skipped++;
          continue;
        }

        try {
          if (afterpay) {
            if (!deliveryCompanies) deliveryCompanies = await listBaseDeliveryCompanies();
            const carrier = deliveryCompanies.find((company) => /その他|other/i.test(company.name));
            if (!carrier) {
              result.blocked++;
              result.errors.push(orderId + ":base_afterpay_delivery_company_mapping_missing");
              continue;
            }
            try {
              await updateBaseOrderItemFulfillment({
                orderItemId: externalLineId,
                trackingNumber,
                atobarai: true,
                deliveryCompanyId: carrier.delivery_company_id,
              });
            } catch (updateError) {
              const detail = await getBaseOrderDetail(externalOrderId);
              if (String(detail.tracking_number ?? "") !== trackingNumber) throw updateError;
            }
          } else {
            const comment = "[配送業者]CJ配送 [送り状番号]" + trackingNumber;
            try {
              await updateBaseOrderItemFulfillment({ orderItemId: externalLineId, trackingNumber, addComment: comment });
            } catch (updateError) {
              // A 5xx can mean the dispatch succeeded but the response was lost; verify before any retry.
              const detail = await getBaseOrderDetail(externalOrderId);
              const item = (detail.order_items ?? []).find((row) => String(row.order_item_id ?? "") === externalLineId);
              const confirmed = item?.status === "dispatched" ||
                String(detail.add_comment ?? "").includes(trackingNumber) ||
                String(detail.tracking_number ?? "").includes(trackingNumber);
              if (!confirmed) throw updateError;
            }
          }

          synced.push({ key, externalLineId, trackingNumber, syncedAt: new Date().toISOString() });
          orderPayloadChanged = true;
          result.synced++;
        } catch (error) {
          result.failed++;
          result.errors.push(orderId + ":" + (error instanceof Error ? error.message : String(error)).slice(0, 180));
        }
      }
    }

    if (orderPayloadChanged) {
      const { error: saveError } = await db.from("commerce_orders").update({
        raw_payload: { ...rawPayload, tracerBaseFulfillmentGroups: synced },
        updated_at: new Date().toISOString(),
      }).eq("id", orderId);
      if (saveError) {
        result.failed++;
        result.errors.push(orderId + ":base_fulfillment_idempotency_save_failed:" + saveError.message);
      }
    }
  }

  return NextResponse.json({ ok: result.failed === 0 && result.blocked === 0, channel: "base", ...result }, {
    status: result.failed || result.blocked ? 207 : 200,
  });
}
