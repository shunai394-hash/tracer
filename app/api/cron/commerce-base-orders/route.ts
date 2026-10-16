import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getBaseOrderDetail, isBaseConfigured, listBaseOrders } from "@/lib/channels/base";
import { ingestPaidOrder } from "@/lib/commerce/core";
import { splitJapaneseAddress } from "@/lib/commerce/japanese-address.mjs";

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
  if (authError) return authError;
  if (!isBaseConfigured()) return NextResponse.json({ ok: false, error: "base_oauth_not_configured" }, { status: 503 });
  const db = createSupabaseAdminClient();
  const result = { checked: 0, paid: 0, imported: 0, duplicate: 0, ignored: 0, failed: 0, errors: [] as string[] };
  try {
    const summaries = await listBaseOrders({ limit: 50, offset: 0 });
    for (const summary of summaries) {
      if (!summary.unique_key) continue;
      result.checked++;
      try {
        const detail = await getBaseOrderDetail(summary.unique_key);
        if (!isPaid(detail)) { result.ignored++; continue; }
        result.paid++;
        const sourceLines = (detail.order_items ?? []).filter((item) => item.status !== "cancelled" && item.item_id !== undefined);
        const lines: Array<{ externalLineId: string; variantId: string; sku: string; quantity: number; unitPrice: number; offerId: string }> = [];
        for (const item of sourceLines) {
          const { data: listing, error: listingError } = await db.from("channel_listings")
            .select("variant_id,external_sku").eq("channel", "base").eq("external_product_id", String(item.item_id)).eq("status", "published").maybeSingle();
          if (listingError) throw new Error("base_item_mapping_read_failed:" + listingError.message);
          if (!listing) continue;
          const { data: price, error: priceError } = await db.from("commerce_prices").select("supplier_offer_id").eq("variant_id", listing.variant_id).maybeSingle();
          if (priceError || !price?.supplier_offer_id) throw new Error("supplier_offer_mapping_missing_for_base_item:" + String(item.item_id));
          const quantity = Math.max(1, Math.floor(Number(item.amount ?? 1)));
          lines.push({
            externalLineId: String(item.order_item_id ?? item.item_id),
            variantId: String(listing.variant_id), sku: String(listing.external_sku ?? ""),
            quantity, unitPrice: Math.round(Number(item.price ?? 0)), offerId: String(price.supplier_offer_id)
          });
        }
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
        if (imported.duplicate) result.duplicate++; else result.imported++;
      } catch (error) {
        result.failed++;
        result.errors.push(String(summary.unique_key) + ":" + (error instanceof Error ? error.message : String(error)).slice(0, 180));
      }
    }
    return NextResponse.json({ ok: result.failed === 0, channel: "base", ...result }, { status: result.failed ? 207 : 200 });
  } catch (error) {
    return NextResponse.json({ ok: false, channel: "base", ...result, error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
