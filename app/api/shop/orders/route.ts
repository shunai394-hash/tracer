import { NextResponse } from "next/server";
import { placeShopOrder, attachStripeCheckoutSession } from "@/lib/shop/store";
import { createDropshipPurchaseOrdersForShopOrder } from "@/lib/ordering/dropship";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createCheckoutSession, toStripeMinorUnits } from "@/lib/payments/stripe/client";
import { getStripeConfig } from "@/lib/config/env";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      items?: Array<{ listingId?: string; qty?: number }>;
      customerName?: string;
      customerEmail?: string;
      customerPhone?: string;
      shippingAddress?: string;
      shippingCountryCode?: string;
      shippingProvince?: string;
      shippingCity?: string;
      shippingZip?: string;
      shippingLine1?: string;
      paymentMethod?: "cash_on_delivery" | "bank_transfer" | "card";
      notes?: string;
    };

    const required = {
      name: body.customerName?.trim(),
      email: body.customerEmail?.trim(),
      phone: body.customerPhone?.trim(),
      countryCode: body.shippingCountryCode?.trim(),
      province: body.shippingProvince?.trim(),
      city: body.shippingCity?.trim(),
      zip: body.shippingZip?.trim(),
      line1: body.shippingLine1?.trim(),
      address: body.shippingAddress?.trim(),
    };
    const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
    if (missing.length > 0) {
      return NextResponse.json(
        { ok: false, error: `customer/shipping information is incomplete: ${missing.join(", ")}` },
        { status: 400 },
      );
    }

    const items = (body.items ?? [])
      .filter((item) => item.listingId && item.qty && item.qty > 0)
      .map((item) => ({ listingId: String(item.listingId), qty: Number(item.qty) }));

    const paymentMethod = body.paymentMethod ?? "cash_on_delivery";
    const order = await placeShopOrder({
      items,
      customerName: required.name!,
      customerEmail: required.email!,
      customerPhone: required.phone!,
      shippingAddress: required.address!,
      shippingCountryCode: required.countryCode!,
      shippingProvince: required.province!,
      shippingCity: required.city!,
      shippingZip: required.zip!,
      shippingLine1: required.line1!,
      paymentMethod,
      notes: body.notes,
    });

    if (paymentMethod === "card") {
      // Fulfillment starts only after the Stripe webhook confirms payment.
      const { siteUrl } = getStripeConfig();
      const base = siteUrl || new URL(request.url).origin;
      const supabase = createSupabaseAdminClient();
      const { data: orderItems, error: itemsError } = await supabase
        .from("shop_order_items")
        .select("*")
        .eq("order_id", order.orderId);
      if (itemsError) throw new Error(itemsError.message);
      if (!orderItems || orderItems.length === 0) throw new Error("order has no items to charge");

      const currency = String(orderItems[0].currency ?? "USD");
      const session = await createCheckoutSession({
        shopOrderId: order.orderId,
        customerEmail: required.email!,
        successUrl: `${base}/shop/thanks?order=${order.orderId}&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${base}/shop/checkout?order=${order.orderId}&cancelled=1`,
        lineItems: orderItems.map((item) => ({
          title: String(item.title),
          quantity: Number(item.qty),
          currency,
          unitAmountMinorUnits: toStripeMinorUnits(Number(item.unit_price ?? 0), currency),
        })),
      });
      await attachStripeCheckoutSession({ orderId: order.orderId, stripeCheckoutSessionId: session.sessionId });
      return NextResponse.json({ ok: true, orderId: order.orderId, checkoutUrl: session.url });
    }

    let procurement: { purchaseOrderIds: string[]; skipped: Array<{ itemId: string; reason: string }> } | null = null;
    try {
      procurement = await createDropshipPurchaseOrdersForShopOrder(order.orderId);
    } catch (procurementError) {
      console.error("[TRACER DROPSHIP PO ERROR]", procurementError);
    }
    return NextResponse.json({ ok: true, orderId: order.orderId, procurement });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 400 });
  }
}
