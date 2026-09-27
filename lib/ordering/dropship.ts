import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getCJConfig, isCJLiveOrderingEnabled, isCJAutoOrderingEnabled } from "@/lib/config/env";
import { checkKillSwitch } from "@/lib/ops/kill-switch";
import { createCJOrderV2 } from "@/lib/sources/cj/create-order";
import { fetchCJVariantStock } from "@/lib/sources/cj/client";
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
  ];
  if (fields.every((value) => value === null || value === undefined)) return null;
  return fields.every((value) => typeof value === "string" && value.trim().length > 0);
}

/**
 * Customer placed a shop order -> create one purchase order per line item
 * (fulfillment_kind = dropship_customer_order). This only records intent; it
 * never calls the supplier. Execution is a separate, explicit step.
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

    const supplierListingId = row.supplier_listing_id
      ? String(row.supplier_listing_id)
      : shopListing.supplier_listing_id
        ? String(shopListing.supplier_listing_id)
        : null;
    if (!supplierListingId) {
      skipped.push({ itemId: String(row.id), reason: "supplier_listing_snapshot_missing" });
      continue;
    }

    const { data: listing } = await supabase
      .from("supplier_listings")
      .select("*")
      .eq("id", supplierListingId)
      .eq("product_id", productId)
      .eq("supplier", "CJdropshipping")
      .maybeSingle();

    if (!listing) {
      skipped.push({ itemId: String(row.id), reason: "supplier_listing_snapshot_not_found" });
      continue;
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
      supplier: "CJdropshipping",
      productId,
    });


    const gate = evaluateDropshipOrderGate({
      vid: typeof listingRow.supplier_variant_id === "string" ? listingRow.supplier_variant_id : (typeof listingRow.cj_variant_id === "string" ? listingRow.cj_variant_id : null),
      quantity: asNumber(row.qty),
      sourceCost: asNumber(listingRow.cost),
      shippingCost: asNumber(listingRow.shipping_cost),
      currency: typeof listingRow.currency === "string" ? listingRow.currency : (typeof row.currency === "string" ? row.currency : null),
      sellingPrice: asNumber(row.unit_price),
      addressComplete: addrComplete,
      killSwitchBlocked: killSwitch.blocked,
      cjConfigured: Boolean(getCJConfig().apiKey),
      liveOrderingEnabled: isCJLiveOrderingEnabled(),
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
          supplier_name: "CJdropshipping",
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
      .eq("purchase_order_id", purchaseOrderId)
      .maybeSingle();

    if (!existingPoItem) {
      const { error: itemError } = await supabase
        .from("purchase_order_items")
        .upsert(
          {
            purchase_order_id: purchaseOrderId,
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
          },
          { onConflict: "purchase_order_id" },
        );

      if (itemError) {
        skipped.push({ itemId: String(row.id), reason: itemError.message });
        continue;
      }
    }

    purchaseOrderIds.push(purchaseOrderId);

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
 * The only place in TRACER that actually calls CJ createOrderV2. Requires an
 * approved, non-blocked purchase order, CJ_LIVE_ORDERING=1, and no active kill
 * switch. Idempotent: re-running for a purchase order that already has a
 * supplier_order_id is a no-op.
 */
export async function executeLivePurchaseOrder(
  purchaseOrderId: string,
): Promise<ExecuteLiveOrderResult> {
  const supabase = createSupabaseAdminClient();

  const { data: po, error: poError } = await supabase
    .from("purchase_orders")
    .select("*")
    .eq("id", purchaseOrderId)
    .maybeSingle();
  if (poError) throw new Error(poError.message);
  if (!po) throw new Error("purchase order not found");

  if (po.fulfillment_kind !== "dropship_customer_order") {
    return {
      purchaseOrderId,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason: "not_a_dropship_order",
      gate: null,
    };
  }

  if (po.supplier_order_id) {
    return {
      purchaseOrderId,
      attempted: false,
      succeeded: true,
      supplierOrderId: String(po.supplier_order_id),
      reason: "already_placed",
      gate: null,
    };
  }

  if (po.status !== "pending_approval" && po.status !== "placed") {
    return {
      purchaseOrderId,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason: `purchase_order_status_${po.status}`,
      gate: null,
    };
  }

  const { data: shopOrder } = po.shop_order_id
    ? await supabase.from("shop_orders").select("*").eq("id", po.shop_order_id).maybeSingle()
    : { data: null };
  const { data: item } = await supabase
    .from("purchase_order_items")
    .select("*")
    .eq("purchase_order_id", purchaseOrderId)
    .limit(1)
    .maybeSingle();

  const shopOrderRow = (shopOrder ?? {}) as Record<string, unknown>;
  const itemRow = (item ?? {}) as Record<string, unknown>;

  const killSwitch = await checkKillSwitch({
    supplier: "CJdropshipping",
    productId: po.product_id ? String(po.product_id) : null,
  });

  // Re-check inventory against the exact supplier identity captured when
  // the sales-test listing was published. Never use the newest listing for
  // fulfillment because it may represent another CJ variant.
  const exactSupplierProductId =
    typeof po.supplier_product_id === "string" ? po.supplier_product_id : null;
  const exactSupplierVariantId =
    typeof po.supplier_variant_id === "string"
      ? po.supplier_variant_id
      : typeof itemRow.cj_variant_id === "string"
        ? itemRow.cj_variant_id
        : null;

  const { data: listing } =
    exactSupplierProductId && exactSupplierVariantId
      ? await supabase
          .from("supplier_listings")
          .select("id, inventory, supplier_product_id, supplier_variant_id, cj_variant_id")
          .eq("supplier", "CJdropshipping")
          .eq("supplier_product_id", exactSupplierProductId)
          .eq("supplier_variant_id", exactSupplierVariantId)
          .maybeSingle()
      : { data: null };

  if (!listing && (!exactSupplierProductId || !exactSupplierVariantId)) {
    return {
      purchaseOrderId,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason: "supplier_identity_missing",
      gate: null,
    };
  }

  let liveInventory: number | null = listing?.inventory ?? null;
  let inventoryLookupError: string | null = null;
  if (exactSupplierVariantId && getCJConfig().apiKey) {
    try {
      liveInventory = await fetchCJVariantStock(exactSupplierVariantId);
    } catch (error) {
      inventoryLookupError = error instanceof Error ? error.message : String(error);
      liveInventory = null;
    }

    if (listing?.id && liveInventory !== null) {
      const { error: inventoryUpdateError } = await supabase
        .from("supplier_listings")
        .update({
          inventory: liveInventory,
          inventory_confirmed: true,
          orderable: liveInventory > 0,
          fetched_at: new Date().toISOString(),
        })
        .eq("id", listing.id);
      if (inventoryUpdateError) throw new Error(inventoryUpdateError.message);
    }
  }

  const gate = evaluateDropshipOrderGate({
    vid: typeof itemRow.cj_variant_id === "string" ? itemRow.cj_variant_id : null,
    quantity: asNumber(po.qty),
    sourceCost: asNumber(po.unit_cost),
    shippingCost: asNumber(po.shipping_cost),
    currency: typeof po.currency === "string" ? po.currency : null,
    sellingPrice: null,
    addressComplete: addressComplete(shopOrderRow),
    killSwitchBlocked: killSwitch.blocked,
    cjConfigured: Boolean(getCJConfig().apiKey),
    liveOrderingEnabled: isCJLiveOrderingEnabled(),
    inventoryQty: liveInventory,
    // Guarded above: this function already returns early when
    // po.supplier_order_id is set, so reaching here means no successful CJ
    // order exists yet for this purchase order.
    duplicateOrderExists: false,
  });

  // Selling price is not required to place the supplier order (only to compute
  // profit), so drop that one requirement here rather than reusing the create-time gate as-is.
  const executionMissing = gate.missing.filter((code) => code !== "selling_price_unknown");
  const canExecuteLive = executionMissing.length === 0 && gate.blocked.length === 0 && !gate.liveOrderingDisabled;

  await supabase
    .from("purchase_orders")
    .update({ metadata: { ...(po.metadata as Record<string, unknown>), gate: { ...gate, missing: executionMissing } } })
    .eq("id", purchaseOrderId);

  if (!canExecuteLive) {
    const reason = gate.liveOrderingDisabled
      ? "cj_live_ordering_disabled"
      : [
          ...gate.blocked,
          ...executionMissing,
          ...(inventoryLookupError ? ["inventory_lookup_failed"] : []),
        ].join(",") || "not_ready";
    return {
      purchaseOrderId,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason,
      gate,
    };
  }

  // CJ_LIVE_ORDERING=1 is necessary but not sufficient: the createOrderV2
  // field mapping is unverified against CJ's live docs (see module header on
  // lib/sources/cj/create-order.ts), so a human must also confirm this
  // specific order before the real supplier call fires.
  if (!po.human_confirmed_at && !isCJAutoOrderingEnabled()) {
    return {
      purchaseOrderId,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason: "human_confirmation_required",
      gate,
    };
  }

  const idempotencyKey = typeof po.idempotency_key === "string" ? po.idempotency_key : `dropship:${purchaseOrderId}`;

  const { data: existingAttempt } = await supabase
    .from("cj_order_attempts")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (existingAttempt?.succeeded && existingAttempt.supplier_order_id) {
    await supabase
      .from("purchase_orders")
      .update({
        supplier_order_id: existingAttempt.supplier_order_id,
        live_order: true,
        supplier_status: "created",
        supplier_synced_at: new Date().toISOString(),
        status: "placed",
      })
      .eq("id", purchaseOrderId);
    return {
      purchaseOrderId,
      attempted: false,
      succeeded: true,
      supplierOrderId: String(existingAttempt.supplier_order_id),
      reason: "deduped_existing_attempt",
      gate,
    };
  }

  const result = await createCJOrderV2({
    orderNumber: idempotencyKey,
    shippingCountryCode: String(shopOrderRow.shipping_country_code ?? ""),
    shippingProvince: String(shopOrderRow.shipping_province ?? ""),
    shippingCity: String(shopOrderRow.shipping_city ?? ""),
    shippingAddress: String(shopOrderRow.shipping_line1 ?? shopOrderRow.shipping_address ?? ""),
    shippingZip: String(shopOrderRow.shipping_zip ?? ""),
    shippingPhone: String(shopOrderRow.customer_phone ?? ""),
    shippingCustomerName: String(shopOrderRow.customer_name ?? ""),
    products: [
      {
        vid: String(itemRow.cj_variant_id ?? ""),
        quantity: asNumber(po.qty) ?? 1,
      },
    ],
  }).catch((error) => ({
    succeeded: false,
    supplierOrderId: null,
    responseCode: "EXCEPTION",
    responseMessage: error instanceof Error ? error.message : "unknown error",
    raw: null,
  }));

  await supabase.from("cj_order_attempts").insert({
    purchase_order_id: purchaseOrderId,
    idempotency_key: idempotencyKey,
    request_summary: { productId: po.product_id, qty: po.qty },
    response_code: result.responseCode,
    response_message: result.responseMessage,
    supplier_order_id: result.supplierOrderId,
    succeeded: result.succeeded,
  });

  if (result.succeeded && result.supplierOrderId) {
    await supabase
      .from("purchase_orders")
      .update({
        supplier_order_id: result.supplierOrderId,
        live_order: true,
        supplier_status: "created",
        supplier_synced_at: new Date().toISOString(),
        status: "placed",
      })
      .eq("id", purchaseOrderId);

    return {
      purchaseOrderId,
      attempted: true,
      succeeded: true,
      supplierOrderId: result.supplierOrderId,
      reason: null,
      gate,
    };
  }

  await supabase
    .from("purchase_orders")
    .update({
      status: "supplier_rejected",
      metadata: {
        ...(po.metadata as Record<string, unknown>),
        gate,
        supplier_error: result.responseMessage,
      },
    })
    .eq("id", purchaseOrderId);

  return {
    purchaseOrderId,
    attempted: true,
    succeeded: false,
    supplierOrderId: null,
    reason: result.responseMessage ?? "supplier_rejected",
    gate,
  };
}
