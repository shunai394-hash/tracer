import "server-only";

import Stripe from "stripe";
import { getStripeConfig } from "@/lib/config/env";
import { toStripeMinorUnits } from "@/lib/payments/stripe/currency";

export { toStripeMinorUnits };

export class StripeConfigError extends Error {
  readonly code = "STRIPE_NOT_CONFIGURED" as const;
  constructor(message = "Stripe is not configured") {
    super(message);
    this.name = "StripeConfigError";
  }
}

let cachedClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  const { secretKey } = getStripeConfig();
  if (!secretKey) throw new StripeConfigError();
  if (!cachedClient) {
    // apiVersion pinned to whatever the installed `stripe` package's types
    // require (see node_modules/stripe for the exact string); bump this
    // together with the package version, not independently.
    cachedClient = new Stripe(secretKey, { apiVersion: "2026-08-26.dahlia" });
  }
  return cachedClient;
}

export type CheckoutLineItem = {
  title: string;
  unitAmountMinorUnits: number;
  currency: string;
  quantity: number;
};

/**
 * Creates a Stripe-hosted Checkout Session. This is the only place TRACER
 * ever touches card details, and it never sees them directly — Stripe hosts
 * the payment form. Card numbers/CVCs are never sent to or stored by TRACER.
 */
export async function createCheckoutSession(args: {
  shopOrderId: string;
  lineItems: CheckoutLineItem[];
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ sessionId: string; url: string | null }> {
  const stripe = getStripeClient();

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: args.customerEmail,
    client_reference_id: args.shopOrderId,
    metadata: { shop_order_id: args.shopOrderId },
    line_items: args.lineItems.map((item) => ({
      quantity: item.quantity,
      price_data: {
        currency: item.currency.toLowerCase(),
        unit_amount: item.unitAmountMinorUnits,
        product_data: { name: item.title },
      },
    })),
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  });

  return { sessionId: session.id, url: session.url };
}

/**
 * Verifies the Stripe-Signature header against the raw request body. This is
 * the only trust boundary for "payment succeeded" — nothing else (a redirect,
 * a client-side callback) is treated as confirmation.
 */
export function constructStripeEvent(rawBody: string, signature: string | null): Stripe.Event {
  const { webhookSecret } = getStripeConfig();
  if (!webhookSecret) throw new StripeConfigError("STRIPE_WEBHOOK_SECRET is not configured");
  if (!signature) throw new Error("missing Stripe-Signature header");

  const stripe = getStripeClient();
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}

