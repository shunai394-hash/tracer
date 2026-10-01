import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getCJConfig, isSupplierConfigured, isSupplierLiveOrderingEnabled } from "@/lib/config/env";
import { checkKillSwitch } from "@/lib/ops/kill-switch";
import { getObservedUsdToJpyRate } from "@/lib/intelligence/fx";
import { executeVerifiedSupplierPurchaseOrder } from "@/lib/ordering/verified-supplier-execution";
import {
  evaluateDropshipOrderGate,
  type DropshipOrderGateResult,
} from "@/lib/ordering/dropship-gate";

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function addressComplete(order: Record<string, unknown>): boolean | null {
  const fields = [
    order.shipping_country_code,
    order.shipping_province,
    order.shipping_city,
    order.shipping_line1,
    order.shipping_zip,
  ];
  if (fields.every((value) => value === null || value === undefined)) return null;
  return fields.every((value) => typeof value === "string" && value.trim().length > 0);
}

/**
 * Customer placed a shop order -> create one purchase order per line item
 * (fulfillment_kind = dropship_customer_order). This only records intent; it
 * never calls the supplier. Execution is a separate, explicit step.
 * Concurrent callers are serialized by the idempotency key and item claim.
 */
export async function createDropshipPurchaseOrdersForShopOrder(
  shopOrderId: string,
): Promise<{ purchaseOrderIds: string[]; skipped: Array<{ itemId: string; reason: string }> }> {
  const supabase = createSupabaseAdminClient();

  const { data: order, error: orderError } = await supabase
    .from("shop_orders")
    .select("*")
    .eq("id", shopOrderId)
    .maybeSingle();
  if (orderError) throw new Error(orderError.message);
  if (!order) throw new Error("shop order not found");

  // Supplier procurement is only authorized after confirmed customer payment.
  // Never create a supplier PO from an unpaid/pending order.
  if (String(order.payment_status) !== "paid") {
    return {
      purchaseOrderIds: [],
      skipped: [{ itemId: "*", reason: "shop_order_payment_not_confirmed" }],
    };
  }

  if (["cancellation_requested", "refund_pending", "cancelled", "refunded"].includes(String(order.order_status))) {
    return { purchaseOrderIds: [], skipped: [{ itemId: "*", reason: `shop_order_${String(order.order_status)}` }] };
  }

  const { data: items, error: itemsError } = await supabase
    .from("shop_order_items")
    .select("*")
    .eq("order_id", shopOrderId);
  if (itemsError) throw new Error(itemsError.message);

  const addrComplete = addressComplete(order as Record<string, unknown>);
  const purchaseOrderIds: string[] = [];
  const skipped: Array<{ itemId: string; reason: string }> = [];

  for (const item of items ?? []) {
    const row = item as Record<string, unknown>;
    const idempotencyKey = `dropship:${row.id}`;

    // Idempotent: a repeated call for the same shop order (e.g. a retried
    // Stripe webhook, or the fulfillment-retry cron) must not create a
    // second purchase order for the same line item.
    const { data: existingPo } = await supabase
      .from("purchase_orders")
      .select("id")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    const productId = row.product_id ? String(row.product_id) : null;
    if (!productId) {
      skipped.push({ itemId: String(row.id), reason: "product_unknown" });
      continue;
    }

    // Fulfillment must use the exact supplier listing selected at publication.
    // Never substitute the newest supplier row for an existing shop listing:
    // a refresh can point the same product at a different CJ variant.
    const shopListingId = row.listing_id ? String(row.listing_id) : null;
    const { data: shopListing } = shopListingId
      ? await supabase
          .from("shop_listings")
          .select("id, product_id, supplier_name, supplier_listing_id, supplier_product_id, supplier_variant_id, source_cost, shipping_cost, currency, orderable, tracking_available")
          .eq("id", shopListingId)
          .maybeSingle()
      : { data: null };

    if (!shopListing) {
      skipped.push({ itemId: String(row.id), reason: "shop_listing_not_found" });
      continue;
    }
    if (String(shopListing.product_id) !== productId) {
      skipped.push({ itemId: String(row.id), reason: "shop_listing_product_mismatch" });
      continue;
    }

    const supplierName = String(shopListing.supplier_name ?? "").trim();
    const isTracerInternal = supplierName.toLowerCase() === "tracer_internal";

    let listing: Record<string, unknown> | null = null;
    if (isTracerInternal) {
      const internalProductId =
        typeof row.supplier_product_id === "string"
          ? row.supplier_product_id
          : typeof shopListing.supplier_product_id === "string"
            ? shopListing.supplier_product_id
            : null;
      const internalVariantId =
        typeof row.supplier_variant_id === "string"
          ? row.supplier_variant_id
          : typeof shopListing.supplier_variant_id === "string"
            ? shopListing.supplier_variant_id
            : null;

      if (!internalProductId || !internalVariantId) {
        skipped.push({ itemId: String(row.id), reason: "internal_supply_variant_snapshot_missing" });
        continue;
      }

      const { data: internalVariant, error: internalVariantError } = await supabase
        .from("internal_supply_variants")
        .select("*,internal_supply_products(*)")
        .eq("id", internalVariantId)
        .eq("supply_product_id", internalProductId)
        .eq("active", true)
        .maybeSingle();

      if (internalVariantError) {
        skipped.push({ itemId: String(row.id), reason: internalVariantError.message });
        continue;
      }
      if (!internalVariant) {
        skipped.push({ itemId: String(row.id), reason: "internal_supply_variant_not_found" });
        continue;
      }

      listing = {
        id: null,
        supplier: "tracer_internal",
        supplier_product_id: internalProductId,
        supplier_variant_id: internalVariantId,
        cost: internalVariant.cost ?? (internalVariant.internal_supply_products as Record<string, unknown> | null)?.cost ?? null,
        shipping_cost: internalVariant.shipping_cost ?? (internalVariant.internal_supply_products as Record<string, unknown> | null)?.shipping_cost ?? 0,
        currency: internalVariant.currency ?? (internalVariant.internal_supply_products as Record<string, unknown> | null)?.currency ?? "JPY",
        inventory: internalVariant.inventory,
        inventory_confirmed: true,
        tracking_available: internalVariant.tracking_available === true || (internalVariant.internal_supply_products as Record<string, unknown> | null)?.tracking_available === true,
        api_available: true,
        orderable: internalVariant.orderable === true && internalVariant.active === true,
      };
    } else {
      const supplierListingId = row.supplier_listing_id
        ? String(row.supplier_listing_id)
        : shopListing.supplier_listing_id
          ? String(shopListing.supplier_listing_id)
          : null;
      if (!supplierListingId) {
        skipped.push({ itemId: String(row.id), reason: "supplier_listing_snapshot_missing" });
        continue;
      }

      const { data: externalListing } = await supabase
        .from("supplier_listings")
        .select("*")
        .eq("id", supplierListingId)
        .eq("product_id", productId)
        .eq("supplier", supplierName)
        .maybeSingle();

      if (!externalListing) {
        skipped.push({ itemId: String(row.id), reason: "supplier_listing_snapshot_not_found" });
        continue;
      }
      listing = externalListing as Record<string, unknown>;
    }

    const listingRow = listing as Record<string, unknown>;
    const expectedVariant =
      typeof row.supplier_variant_id === "string"
        ? row.supplier_variant_id
        : typeof shopListing.supplier_variant_id === "string"
          ? shopListing.supplier_variant_id
          : null;
    const actualVariant =
      typeof listingRow.supplier_variant_id === "string"
        ? listingRow.supplier_variant_id
        : typeof listingRow.cj_variant_id === "string"
          ? listingRow.cj_variant_id
          : null;
    if (expectedVariant && actualVariant && expectedVariant !== actualVariant) {
      skipped.push({ itemId: String(row.id), reason: "supplier_variant_snapshot_mismatch" });
      continue;
    }
    const killSwitch = await checkKillSwitch({
      supplier: String(shopListing.supplier_name ?? "").trim(),
      productId,
    });


    const sourceCurrency = typeof listingRow.currency === "string" ? listingRow.currency.toUpperCase() : null;
    const sellingCurrency = typeof row.currency === "string" ? row.currency.toUpperCase() : null;
    const fxQuote = sourceCurrency === sellingCurrency
      ? 1
      : sourceCurrency === "USD" && sellingCurrency === "JPY"
        ? (await getObservedUsdToJpyRate())?.rate ?? null
        : null;

    const gate = evaluateDropshipOrderGate({
      vid: typeof listingRow.supplier_variant_id === "string" ? listingRow.supplier_variant_id : (typeof listingRow.cj_variant_id === "string" ? listingRow.cj_variant_id : null),
      quantity: asNumber(row.qty),
      sourceCost: asNumber(listingRow.cost),
      shippingCost: asNumber(listingRow.shipping_cost),
      currency: sourceCurrency,
      sellingPrice: asNumber(row.unit_price),
      sourceFxRateToSelling: fxQuote,
      addressComplete: addrComplete,
      killSwitchBlocked: killSwitch.blocked,
      supplierConfigured: isSupplierConfigured(String(shopListing.supplier_name ?? "CJdropshipping")),
      cjConfigured: Boolean(getCJConfig().apiKey),
      liveOrderingEnabled: isSupplierLiveOrderingEnabled(String(shopListing.supplier_name ?? "CJdropshipping")),
      inventoryQty: typeof listingRow.inventory === "number" ? listingRow.inventory : null,
      duplicateOrderExists: false,
    });

    const status =
      gate.missing.length > 0 || gate.blocked.length > 0
        ? "auto_blocked"
        : "pending_approval";

    let purchaseOrderId = existingPo ? String(existingPo.id) : null;

    if (!purchaseOrderId) {
      const { data: po, error: poError } = await supabase
        .from("purchase_orders")
        .insert({
          product_id: productId,
          shop_order_id: shopOrderId,
          fulfillment_kind: "dropship_customer_order",
          supplier_name: String(shopListing.supplier_name ?? listingRow.supplier ?? "CJdropshipping"),
          supplier_product_id:
            typeof listingRow.supplier_product_id === "string"
              ? listingRow.supplier_product_id
              : typeof shopListing.supplier_product_id === "string"
                ? shopListing.supplier_product_id
                : null,
          supplier_variant_id:
            typeof listingRow.supplier_variant_id === "string"
              ? listingRow.supplier_variant_id
              : typeof listingRow.cj_variant_id === "string"
                ? listingRow.cj_variant_id
                : typeof shopListing.supplier_variant_id === "string"
                  ? shopListing.supplier_variant_id
                  : null,
          qty: asNumber(row.qty) ?? 0,
          unit_cost: asNumber(listingRow.cost),
          shipping_cost: asNumber(listingRow.shipping_cost),
          total_cost:
            asNumber(listingRow.cost) !== null && asNumber(listingRow.shipping_cost) !== null
              ? (asNumber(listingRow.cost)! + asNumber(listingRow.shipping_cost)!) * (asNumber(row.qty) ?? 0)
              : null,
          currency: typeof listingRow.currency === "string" ? listingRow.currency : row.currency,
          forecast_units: null,
          forecast_profit: gate.estimatedProfit,
          forecast_confidence: null,
          rationale: "customer_order",
          status,
          mode: "APPROVAL",
          idempotency_key: idempotencyKey,
          metadata: {
            gate,
            note: gate.canExecuteLive ? "ready_for_live_execution" : "blocked_or_incomplete",
          },
        })
        .select("id")
        .single();

      if (poError) {
        if (poError.code === "23505") {
          const { data: racedPo } = await supabase
            .from("purchase_orders")
            .select("id")
            .eq("idempotency_key", idempotencyKey)
            .maybeSingle();
          purchaseOrderId = racedPo?.id ? String(racedPo.id) : null;
        }
        if (!purchaseOrderId) {
          skipped.push({ itemId: String(row.id), reason: poError.message });
          continue;
        }
      } else {
        purchaseOrderId = po?.id ? String(po.id) : null;
      }
    }

    if (!purchaseOrderId) {
      skipped.push({ itemId: String(row.id), reason: "purchase_order_id_missing" });
      continue;
    }

    const { data: existingPoItem } = await supabase
      .from("purchase_order_items")
      .select("id")
      .eq("idempotency_key", `dropship-item:${row.id}`)
      .maybeSingle();

    if (!existingPoItem) {
      const { error: itemError } = await supabase
        .from("purchase_order_items")
        .upsert(
          {
            purchase_order_id: purchaseOrderId,
            idempotency_key: `dropship-item:${row.id}`,
            product_id: productId,
            qty: asNumber(row.qty) ?? 0,
            unit_cost: asNumber(listingRow.cost),
            cj_variant_id:
              typeof listingRow.supplier_variant_id === "string"
                ? listingRow.supplier_variant_id
                : typeof listingRow.cj_variant_id === "string"
                  ? listingRow.cj_variant_id
                  : typeof shopListing.supplier_variant_id === "string"
                    ? shopListing.supplier_variant_id
                    : null,
            supplier_variant_id:
              typeof listingRow.supplier_variant_id === "string"
                ? listingRow.supplier_variant_id
                : typeof listingRow.cj_variant_id === "string"
                  ? listingRow.cj_variant_id
                  : typeof shopListing.supplier_variant_id === "string"
                    ? shopListing.supplier_variant_id
                    : null,
          },
          { onConflict: "idempotency_key" },
        );

      if (itemError) {
        skipped.push({ itemId: String(row.id), reason: itemError.message });
        continue;
      }
    }

    purchaseOrderIds.push(purchaseOrderId);
  }

  return { purchaseOrderIds, skipped };
}

/**
 * Explicit, per-order human sign-off required before a live supplier order
 * call fires (executeLivePurchaseOrder for CJ, executeLiveOrosyOrder for
 * orosy — see lib/ordering/orosy-order.ts). Supplier-agnostic; intended to
 * be called only from an authenticated admin action.
 */
export async function confirmPurchaseOrderForLiveExecution(args: {
  purchaseOrderId: string;
  confirmedBy: string;
}): Promise<{ confirmed: boolean; reason: string | null }> {
  const supabase = createSupabaseAdminClient();

  const { data: po, error } = await supabase
    .from("purchase_orders")
    .select("id, fulfillment_kind, supplier_order_id, status")
    .eq("id", args.purchaseOrderId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!po) return { confirmed: false, reason: "purchase_order_not_found" };
  if (po.fulfillment_kind !== "dropship_customer_order" && po.fulfillment_kind !== "inventory_reorder") {
    return { confirmed: false, reason: "unsupported_fulfillment_kind" };
  }
  if (po.supplier_order_id) {
    return { confirmed: false, reason: "already_placed" };
  }

  const { error: updateError } = await supabase
    .from("purchase_orders")
    .update({ human_confirmed_at: new Date().toISOString(), human_confirmed_by: args.confirmedBy })
    .eq("id", args.purchaseOrderId);
  if (updateError) throw new Error(updateError.message);

  return { confirmed: true, reason: null };
}

export type ExecuteLiveOrderResult = {
  purchaseOrderId: string;
  attempted: boolean;
  succeeded: boolean;
  supplierOrderId: string | null;
  reason: string | null;
  gate: DropshipOrderGateResult | null;
};

/**
 * The single supplier-agnostic live-order entry point. It delegates to the
 * registered Supplier Adapter after all common gates pass. Idempotent:
 * re-running a purchase order that already has a supplier_order_id is a no-op.
 */
export async function executeLivePurchaseOrder(
  purchaseOrderId: string,
): Promise<ExecuteLiveOrderResult> {
  // Route through the payment-verifying wrapper: a supplier order ID alone
  // is never a successful purchase.
  const result = await executeVerifiedSupplierPurchaseOrder(purchaseOrderId);
  return {
    purchaseOrderId: result.purchaseOrderId,
    attempted: result.attempted,
    succeeded: result.succeeded,
    supplierOrderId: result.supplierOrderId,
    reason: result.reason,
    gate: result.gate,
  };
}
