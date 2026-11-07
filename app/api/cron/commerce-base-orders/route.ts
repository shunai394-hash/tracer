import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getBaseOrderDetail, isBaseConfigured, listBaseOrders } from "@/lib/channels/base";
import { ingestPaidOrder } from "@/lib/commerce/core";
import { resolveBaseOrderVariant } from "@/lib/commerce/variant-family.mjs";
import { splitJapaneseAddress } from "@/lib/commerce/japanese-address.mjs";

const BASE_UNMAPPED_ORDER_ITEM_EVENT = "base_order_unmapped_item";
const BASE_ORDER_SCAN_CURSOR_EVENT = "base_order_scan_cursor";
const BASE_ORDER_PAGE_SIZE = 50;
const BASE_ORDER_SCAN_MAX_OFFSET = 50000;

export const runtime = "nodejs";
export const maxDuration = 300;

function isPaid(order: Awaited<ReturnType<typeof getBaseOrderDetail>>): boolean {
  if (order.dispatch_status === "unpaid" || order.dispatch_status === "cancelled" || order.dispatch_status === "unshippable") return false;
  switch (order.payment) {
    case "cvs": return order.cvs_payment_transaction?.status === "paid";
    case "base_bt": return order.bt_payment_transaction?.status === "paid";
    case "creditcard": return order.c_c_payment_transaction?.status === "captured";
    case "carrier_01":
    case "carrier_02":
    case "carrier_03": return order.carrier_payment_transaction?.status === "captured";
    case "paypal": return order.paypal_payment_transaction?.status === "captured";
    case "amazon_pay": return order.amazon_payment_transaction?.status === "captured";
    case "paypay": return order.paypay_payment_transaction?.status === "captured";
    case "bnpl":
    case "bnpl_installment": return order.bnpl_payment_transaction?.status === "captured";
    default: return false;
  }
}

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) {
    console.warn("[TRACER BASE ORDER POLL AUTH REJECTED]", {
      status: authError.status,
      vercelCron: request.headers.get("x-vercel-cron") === "1",
      userAgent: (request.headers.get("user-agent") ?? "unknown").slice(0, 120),
      vercelIdPresent: Boolean(request.headers.get("x-vercel-id")),
      authorizationScheme: request.headers.get("authorization")?.split(" ", 1)[0] ?? "missing",
    });
    return authError;
  }
  if (!isBaseConfigured()) return NextResponse.json({ ok: false, error: "base_oauth_not_configured" }, { status: 503 });
  const db = createSupabaseAdminClient();
  const result = { checked: 0, paid: 0, imported: 0, duplicate: 0, ignored: 0, failed: 0, unmappedItems: 0, scanOffsets: [] as number[], errors: [] as string[] };
  try {
    // Always scan the newest page, then rotate through older pages so paid
    // orders beyond the first 50 cannot starve forever.
    const { data: cursorRow, error: cursorReadError } = await db.from("commerce_events")
      .select("detail").eq("event_key", BASE_ORDER_SCAN_CURSOR_EVENT).maybeSingle();
    if (cursorReadError) throw new Error("base_order_scan_cursor_read_failed:" + cursorReadError.message);
    const cursorDetail = cursorRow?.detail && typeof cursorRow.detail === "object" && !Array.isArray(cursorRow.detail)
      ? cursorRow.detail as Record<string, unknown>
      : {};
    const storedOffset = Number(cursorDetail.offset);
    const scanOffset = Number.isSafeInteger(storedOffset) && storedOffset >= BASE_ORDER_PAGE_SIZE && storedOffset <= BASE_ORDER_SCAN_MAX_OFFSET
      ? storedOffset
      : BASE_ORDER_PAGE_SIZE;
    // Bound BASE polling to the most recent 365 days and use the same window for both pages.
    const endOrdered = new Date().toISOString().slice(0, 10);
    const startOrdered = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [recentSummaries, rotatingSummaries] = await Promise.all([
      listBaseOrders({ startOrdered, endOrdered, limit: BASE_ORDER_PAGE_SIZE, offset: 0 }),
      listBaseOrders({ startOrdered, endOrdered, limit: BASE_ORDER_PAGE_SIZE, offset: scanOffset }),
    ]);
    result.scanOffsets = [0, scanOffset];
    const summaries = [...new Map([...recentSummaries, ...rotatingSummaries]
      .filter((summary) => Boolean(summary.unique_key))
      .map((summary) => [String(summary.unique_key), summary] as const)).values()];
    const nextOffset = rotatingSummaries.length < BASE_ORDER_PAGE_SIZE || scanOffset >= BASE_ORDER_SCAN_MAX_OFFSET
      ? BASE_ORDER_PAGE_SIZE
      : scanOffset + BASE_ORDER_PAGE_SIZE;
    for (const summary of summaries) {
      if (!summary.unique_key) continue;
      result.checked++;
      try {
        const detail = await getBaseOrderDetail(summary.unique_key);
        if (!isPaid(detail)) { result.ignored++; continue; }
        result.paid++;
        const sourceLines = (detail.order_items ?? []).filter((item) => item.status !== "cancelled");
        if (sourceLines.some((item) => item.item_id === undefined || item.item_id === null || !String(item.item_id).trim() || item.order_item_id === undefined || item.order_item_id === null || !String(item.order_item_id).trim())) {
          throw new Error("base_order_line_identity_missing");
        }
        const lines: Array<{ externalLineId: string; variantId: string; sku: string; quantity: number; unitPrice: number; offerId: string; selection: Record<string, unknown> }> = [];
        let hasUnmappedLine = false;
        for (const item of sourceLines) {
          const { data: listingRows, error: listingError } = await db.from("channel_listings")
            .select("variant_id,external_product_id,external_variant_id,external_sku,status").eq("channel", "base").eq("external_product_id", String(item.item_id)).eq("status", "published");
          if (listingError) throw new Error("base_item_mapping_read_failed:" + listingError.message);
          const resolved = resolveBaseOrderVariant({
            itemId: item.item_id,
            variationId: item.variation_id,
            variationIdentifier: item.variation_identifier,
          }, listingRows ?? []);
          const listing = resolved.ok ? { variant_id: resolved.variantId, external_sku: (listingRows ?? []).find((row) => String(row.variant_id) === resolved.variantId)?.external_sku ?? "" } : null;
          if (!listing) {
            // A paid line for a BASE item TRACER does not link (legacy, duplicate
            // or foreign listing) must never vanish: record it for a person to
            // resolve. It is not procured automatically.
            result.unmappedItems++;
            const { error: unmappedError } = await db.from("commerce_events").upsert({
              event_key: "base_order_unmapped_item:" + String(detail.unique_key) + ":" + String(item.order_item_id),
              event_type: BASE_UNMAPPED_ORDER_ITEM_EVENT,
              entity_type: "base_order",
              entity_id: String(detail.unique_key),
              status: "needs_review",
              detail: { baseItemId: String(item.item_id), orderItemId: String(item.order_item_id), quantity: Math.max(1, Math.floor(Number(item.amount ?? 1))) },
            }, { onConflict: "event_key", ignoreDuplicates: true });
            if (unmappedError) throw new Error("base_unmapped_item_record_failed:" + unmappedError.message);
            result.errors.push(String(summary.unique_key) + ":base_item_not_linked:" + String(item.item_id));
            hasUnmappedLine = true;
            continue;
          }
          const { data: price, error: priceError } = await db.from("commerce_prices").select("supplier_offer_id").eq("variant_id", listing.variant_id).maybeSingle();
          if (priceError || !price?.supplier_offer_id) throw new Error("supplier_offer_mapping_missing_for_base_item:" + String(item.item_id));
          const quantity = Math.max(1, Math.floor(Number(item.amount ?? 1)));
          lines.push({
            externalLineId: String(item.order_item_id),
            variantId: String(listing.variant_id), sku: String(listing.external_sku ?? ""),
            quantity, unitPrice: Math.round(Number(item.price ?? 0)), offerId: String(price.supplier_offer_id),
            selection: {
              channel: "base",
              variation: item.variation ?? null,
              variationId: item.variation_id ?? null,
              variationIdentifier: item.variation_identifier ?? null,
              supplierVariantId: resolved.ok ? resolved.supplierVariantId : null,
            },
          });
        }
        // Never procure only the mapped subset of a multi-line paid order. Keep
        // the full order out of the canonical ledger until every line is linked.
        if (hasUnmappedLine) { result.ignored++; continue; }
        if (!lines.length) { result.ignored++; continue; }
        const prefecture = detail.prefecture ?? detail.order_receiver?.prefecture ?? "";
        const rawAddress = detail.address ?? detail.order_receiver?.address ?? "";
        const parsedAddress = splitJapaneseAddress(rawAddress, prefecture);
        const imported = await ingestPaidOrder({
          channel: "base", externalOrderId: String(detail.unique_key),
          totalAmount: Math.round(Number(detail.total ?? 0)),
          customerName: [detail.first_name, detail.last_name].filter(Boolean).join(" ").trim() || null,
          shippingAddress: {
            country: detail.country ?? detail.order_receiver?.country ?? "",
            country_code: detail.country_code ?? detail.order_receiver?.country_code ?? "",
            zip: detail.zip_code ?? detail.order_receiver?.zip_code ?? "",
            prefecture,
            city: parsedAddress.city,
            address1: parsedAddress.address1,
            address: parsedAddress.address1,
            address2: detail.address2 ?? detail.order_receiver?.address2 ?? "",
            phone: detail.tel ?? detail.order_receiver?.tel ?? ""
          },
          rawPayload: { unique_key: detail.unique_key, dispatch_status: detail.dispatch_status, payment: detail.payment },
          lines
        });
        const outcome = imported.duplicate ? "duplicate" : "imported";
        result[imported.duplicate ? "duplicate" : "imported"]++;
        const { error: resolvedError } = await db.from("commerce_events").upsert({
          event_key: "base_order_import_error:" + String(detail.unique_key),
          event_type: "base_order_import_error",
          entity_type: "base_order",
          entity_id: String(detail.unique_key),
          status: "resolved",
          detail: { outcome, resolvedAt: new Date().toISOString() },
        }, { onConflict: "event_key" });
        if (resolvedError) throw new Error("base_order_error_event_resolve_failed:" + resolvedError.message);
      } catch (error) {
        result.failed++;
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 180);
        result.errors.push(String(summary.unique_key) + ":" + message);
        // Persist per-order failures instead of relying on ephemeral cron output.
        // The next poll can retry the order and mark this event resolved.
        const { error: eventError } = await db.from("commerce_events").upsert({
          event_key: "base_order_import_error:" + String(summary.unique_key),
          event_type: "base_order_import_error",
          entity_type: "base_order",
          entity_id: String(summary.unique_key),
          status: "needs_review",
          detail: { error: message, lastSeenAt: new Date().toISOString() },
        }, { onConflict: "event_key" });
        if (eventError) result.errors.push(String(summary.unique_key) + ":error_event_write_failed:" + eventError.message.slice(0, 100));
      }
    }
    const { error: cursorWriteError } = await db.from("commerce_events").upsert({
      event_key: BASE_ORDER_SCAN_CURSOR_EVENT,
      event_type: BASE_ORDER_SCAN_CURSOR_EVENT,
      entity_type: "system",
      entity_id: "base-order-scan",
      status: "active",
      detail: { offset: nextOffset, pageSize: BASE_ORDER_PAGE_SIZE, scannedAt: new Date().toISOString() },
    }, { onConflict: "event_key" });
    if (cursorWriteError) throw new Error("base_order_scan_cursor_write_failed:" + cursorWriteError.message);
    const healthy = result.failed === 0 && result.unmappedItems === 0;
    console.info("[TRACER BASE ORDER POLL]", {
      ok: healthy, checked: result.checked, paid: result.paid, imported: result.imported,
      duplicate: result.duplicate, ignored: result.ignored, failed: result.failed,
      unmappedItems: result.unmappedItems, scanOffsets: result.scanOffsets, nextScanOffset: nextOffset,
      orderWindow: { startOrdered, endOrdered },
      summaryCounts: { recent: recentSummaries.length, rotating: rotatingSummaries.length },
    });
    return NextResponse.json({ ok: healthy, channel: "base", nextScanOffset: nextOffset, ...result }, { status: healthy ? 200 : 207 });
  } catch (error) {
    console.error("[TRACER BASE ORDER POLL FAILED]", {
      checked: result.checked, paid: result.paid, imported: result.imported,
      failed: result.failed, error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false, channel: "base", ...result, error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
