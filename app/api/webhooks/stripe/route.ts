import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { constructStripeEvent } from "@/lib/payments/stripe/client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createDropshipPurchaseOrdersForShopOrder } from "@/lib/ordering/dropship";
import { recordShopFunnelEvent } from "@/lib/shop/store";

export const runtime = "nodejs";

async function claimEvent(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  event: Stripe.Event,
): Promise<{ alreadyProcessed: boolean }> {
  const { data: existing } = await supabase
    .from("stripe_webhook_events")
    .select("processed")
    .eq("stripe_event_id", event.id)
    .maybeSingle();

  if (existing) {
    return { alreadyProcessed: existing.processed === true };
  }

  await supabase.from("stripe_webhook_events").insert({
    stripe_event_id: event.id,
    event_type: event.type,
    payload: event as unknown as Record<string, unknown>,
    processed: false,
  });

  return { alreadyProcessed: false };
}

async function markProcessed(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  eventId: string,
  shopOrderId: string | null,
  error?: string,
): Promise<void> {
  await supabase
    .from("stripe_webhook_events")
    .update({
      processed: !error,
      processing_error: error ?? null,
      shop_order_id: shopOrderId,
      processed_at: new Date().toISOString(),
    })
    .eq("stripe_event_id", eventId);
}

async function handleCheckoutCompleted(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  session: Stripe.Checkout.Session,
): Promise<string | null> {
  const shopOrderId = session.metadata?.shop_order_id ?? session.client_reference_id ?? null;
  if (!shopOrderId) return null;

  if (session.payment_status !== "paid") {
    // Checkout completed but the payment itself did not succeed (e.g. async
    // payment method still pending) — do not treat this as confirmed.
    return shopOrderId;
  }

  const { data: order } = await supabase
    .from("shop_orders")
    .select("id, payment_status")
    .eq("id", shopOrderId)
    .maybeSingle();
  if (!order) return shopOrderId;

  // Idempotent: if this order is already paid (a retried/duplicate webhook
  // delivery), do not re-fire funnel events or re-create purchase orders.
  if (order.payment_status === "paid") return shopOrderId;

  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;

  await supabase
    .from("shop_orders")
    .update({
      payment_status: "paid",
      order_status: "paid",
      paid_at: new Date().toISOString(),
      stripe_payment_intent_id: paymentIntentId,
    })
    .eq("id", shopOrderId);

  const { data: items } = await supabase
    .from("shop_order_items")
    .select("listing_id, qty")
    .eq("order_id", shopOrderId);
  for (const item of items ?? []) {
    if (!item.listing_id) continue;
    await recordShopFunnelEvent({
      listingId: String(item.listing_id),
      eventType: "purchase",
      qty: Number(item.qty ?? 1),
    }).catch((error) => console.error("[TRACER FUNNEL EVENT ERROR]", error));
  }

  try {
    await createDropshipPurchaseOrdersForShopOrder(shopOrderId);
    await supabase
      .from("shop_orders")
      .update({ order_status: "fulfillment_pending" })
      .eq("id", shopOrderId);
  } catch (error) {
    console.error("[TRACER POST-PAYMENT FULFILLMENT ERROR]", error);
    // Payment is still confirmed and recorded; fulfillment can be retried
    // by the fulfillment-retry cron without re-charging the customer.
  }

  return shopOrderId;
}

async function handlePaymentFailed(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  paymentIntent: Stripe.PaymentIntent,
): Promise<string | null> {
  const { data: order } = await supabase
    .from("shop_orders")
    .select("id")
    .eq("stripe_payment_intent_id", paymentIntent.id)
    .maybeSingle();

  const shopOrderId = order?.id ? String(order.id) : null;
  if (!shopOrderId) return null;

  await supabase
    .from("shop_orders")
    .update({ payment_status: "failed", order_status: "order_failed" })
    .eq("id", shopOrderId);

  return shopOrderId;
}

async function handleChargeRefunded(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  charge: Stripe.Charge,
): Promise<string | null> {
  const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id ?? null;
  if (!paymentIntentId) return null;

  const { data: order } = await supabase
    .from("shop_orders")
    .select("id, total")
    .eq("stripe_payment_intent_id", paymentIntentId)
    .maybeSingle();

  const shopOrderId = order?.id ? String(order.id) : null;
  if (!shopOrderId) return null;

  const refundedMinorUnits = charge.amount_refunded ?? 0;
  const currency = charge.currency ?? "";
  const zeroDecimal = new Set(["jpy", "krw", "vnd"]);
  const refundAmount = zeroDecimal.has(currency) ? refundedMinorUnits : refundedMinorUnits / 100;
  const fullyRefunded = order?.total !== null && order?.total !== undefined && refundAmount >= Number(order.total);

  await supabase
    .from("shop_orders")
    .update({
      payment_status: fullyRefunded ? "refunded" : "partially_refunded",
      order_status: fullyRefunded ? "refunded" : "paid",
      refunded_at: new Date().toISOString(),
      refund_amount: refundAmount,
    })
    .eq("id", shopOrderId);

  return shopOrderId;
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  let event: Stripe.Event;
  try {
    event = constructStripeEvent(rawBody, signature);
  } catch (error) {
    console.error("[TRACER STRIPE WEBHOOK SIGNATURE ERROR]", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "invalid signature" },
      { status: 400 },
    );
  }

  const supabase = createSupabaseAdminClient();
  const claim = await claimEvent(supabase, event);
  if (claim.alreadyProcessed) {
    return NextResponse.json({ ok: true, deduped: true });
  }

  let shopOrderId: string | null = null;
  try {
    switch (event.type) {
      case "checkout.session.completed":
        shopOrderId = await handleCheckoutCompleted(supabase, event.data.object as Stripe.Checkout.Session);
        break;
      case "payment_intent.payment_failed":
        shopOrderId = await handlePaymentFailed(supabase, event.data.object as Stripe.PaymentIntent);
        break;
      case "charge.refunded":
        shopOrderId = await handleChargeRefunded(supabase, event.data.object as Stripe.Charge);
        break;
      default:
        // Unhandled event types are acknowledged (2xx) so Stripe does not
        // retry them forever, but nothing in TRACER reacts to them.
        break;
    }

    await markProcessed(supabase, event.id, shopOrderId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[TRACER STRIPE WEBHOOK HANDLER ERROR]", error);
    await markProcessed(supabase, event.id, shopOrderId, error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ ok: false, error: "handler failed" }, { status: 500 });
  }
}
