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

    if (!body.customerName || !body.customerEmail || !body.shippingAddress) {
      return NextResponse.json(
        { ok: false, error: "name, email and address are required" },
        { status: 400 },
      );
    }

    const items = (body.items ?? [])
      .filter((item) => item.listingId && item.qty && item.qty > 0)
      .map((item) => ({
        listingId: String(item.listingId),
        qty: Number(item.qty),
      }));

    const paymentMethod = body.paymentMethod ?? "cash_on_delivery";

    const order = await placeShopOrder({
      items,
      customerName: body.customerName,
      customerEmail: body.customerEmail,
      customerPhone: body.customerPhone ?? "",
      shippingAddress: body.shippingAddress,
      shippingCountryCode: body.shippingCountryCode,
      shippingProvince: body.shippingProvince,
      shippingCity: body.shippingCity,
      shippingZip: body.shippingZip,
      shippingLine1: body.shippingLine1,
      paymentMethod,
      notes: body.notes,
    });

    if (paymentMethod === "card") {
      // Fulfillment (dropship PO creation, CJ execution) does not start here.
      // It starts only once app/api/webhooks/stripe/route.ts confirms payment.
      const { siteUrl } = getStripeConfig();
      const base = siteUrl || new URL(request.url).origin;

      const supabase = createSupabaseAdminClient();
      const { data: orderItems, error: itemsError } = await supabase
        .from("shop_order_items")
        .select("*")
        .eq("order_id", order.orderId);
      if (itemsError) throw new Error(itemsError.message);
      if (!orderItems || orderItems.length === 0) {
        throw new Error("order has no items to charge");
      }

      const currency = String(orderItems[0].currency ?? "USD");
      const session = await createCheckoutSession({
        shopOrderId: order.orderId,
        customerEmail: body.customerEmail,
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
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 400 },
    );
  }
}
