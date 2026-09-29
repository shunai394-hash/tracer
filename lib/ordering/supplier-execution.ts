import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  isSupplierAutoOrderingEnabled,
  isSupplierLiveOrderingEnabled,
  isSupplierConfigured,
  isSupplierDryRunEnabled,
} from "@/lib/config/env";
import { getSupplierAdapter, getSupplierCapabilities } from "@/lib/procurement/registry";
import type { SupplierOrderInput } from "@/lib/procurement/types";
import { initializeProcurement } from "@/lib/procurement/init";
import { checkKillSwitch } from "@/lib/ops/kill-switch";
import { getObservedFxRate } from "@/lib/intelligence/fx";
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

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function addressComplete(order: Record<string, unknown>): boolean | null {
  const fields = [
    order.shipping_country_code,
    order.shipping_province,
    order.shipping_city,
    order.shipping_line1 ?? order.shipping_address,
    order.shipping_zip,
  ];
  if (fields.every((value) => value === null || value === undefined)) return null;
  return fields.every((value) => typeof value === "string" && value.trim().length > 0);
}

async function resolveFxRate(
  sourceCurrency: string | null,
  sellingCurrency: string | null,
): Promise<number | null> {
  if (!sourceCurrency || !sellingCurrency) return null;
  if (sourceCurrency === sellingCurrency) return 1;
  return (await getObservedFxRate(sourceCurrency, sellingCurrency))?.rate ?? null;
}

export type ExecuteSupplierPurchaseOrderResult = {
  purchaseOrderId: string;
  supplierName: string;
  attempted: boolean;
  succeeded: boolean;
  supplierOrderId: string | null;
  reason: string | null;
  gate: DropshipOrderGateResult | null;
};

export async function executeSupplierPurchaseOrder(
  purchaseOrderId: string,
): Promise<ExecuteSupplierPurchaseOrderResult> {
  initializeProcurement();
  const supabase = createSupabaseAdminClient();

  const { data: po, error: poError } = await supabase
    .from("purchase_orders")
    .select("*")
    .eq("id", purchaseOrderId)
    .maybeSingle();
  if (poError) throw new Error(poError.message);
  if (!po) throw new Error("purchase order not found");

  const supplierName = String(po.supplier_name ?? "").trim();
  if (po.supplier_order_id) {
    return {
      purchaseOrderId,
      supplierName,
      attempted: false,
      succeeded: true,
      supplierOrderId: String(po.supplier_order_id),
      reason: "already_placed",
      gate: null,
    };
  }

  if (po.fulfillment_kind !== "dropship_customer_order") {
    return {
      purchaseOrderId,
      supplierName,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason: "not_a_dropship_order",
      gate: null,
    };
  }

  if (po.status !== "pending_approval" && po.status !== "auto_blocked" && po.status !== "placed") {
    return {
      purchaseOrderId,
      supplierName,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason: `purchase_order_status_${po.status}`,
      gate: null,
    };
  }

  const adapter = getSupplierAdapter(supplierName);
  if (!adapter) {
    return {
      purchaseOrderId,
      supplierName,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason: "supplier_adapter_not_registered",
      gate: null,
    };
  }

  const capabilities = getSupplierCapabilities(supplierName);
  const requiredCapabilities = [
    ["variant", capabilities.variant],
    ["inventory", capabilities.inventory],
    ["price", capabilities.price],
    ["shipping", capabilities.shipping],
    ["orderCreation", capabilities.orderCreation],
    ["payment", capabilities.payment],
    ["liveOrdering", capabilities.liveOrdering],
  ] as const;
  const missingCapabilities = requiredCapabilities
    .filter(([, supported]) => !supported)
    .map(([name]) => name);
  if (missingCapabilities.length > 0) {
    return {
      purchaseOrderId,
      supplierName,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason: `supplier_capability_missing:${missingCapabilities.join(",")}`,
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

  const { data: duplicateAttempts } = await supabase
    .from("supplier_order_attempts")
    .select("id,purchase_order_id,supplier_order_id,state")
    .eq("purchase_order_id", purchaseOrderId)
    .neq("idempotency_key", asString(po.idempotency_key) ?? `dropship:${purchaseOrderId}`)
    .limit(1);

  const duplicateOrderExists = Boolean(duplicateAttempts?.length);

  const shopOrderRow = (shopOrder ?? {}) as Record<string, unknown>;
  const itemRow = (item ?? {}) as Record<string, unknown>;
  const productId = asString(po.product_id);
  const supplierProductId = asString(po.supplier_product_id);
  const supplierVariantId = asString(po.supplier_variant_id) ?? asString(itemRow.supplier_variant_id ?? itemRow.cj_variant_id);

  if (!supplierProductId || !supplierVariantId) {
    return {
      purchaseOrderId,
      supplierName,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason: "supplier_identity_missing",
      gate: null,
    };
  }

  const killSwitch = await checkKillSwitch({
    supplier: supplierName,
    productId,
  });

  let variant = null;
  let inventory = null;
  let price = null;
  let shipping = null;

  try {
    variant = await adapter.getVariant(supplierProductId, supplierVariantId);
    inventory = await adapter.getInventory(supplierProductId, supplierVariantId);
    price = await adapter.getPrice(supplierProductId, supplierVariantId);
    shipping = await adapter.getShipping(supplierProductId, supplierVariantId, {
      destinationCountryCode: asString(shopOrderRow.shipping_country_code) ?? undefined,
      destinationPostalCode: asString(shopOrderRow.shipping_zip) ?? undefined,
      quantity: asNumber(po.qty) ?? 1,
    });
  } catch (error) {
    return {
      purchaseOrderId,
      supplierName,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason: `supplier_live_refresh_failed:${error instanceof Error ? error.message : String(error)}`,
      gate: null,
    };
  }

  if (!variant) {
    return {
      purchaseOrderId,
      supplierName,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason: "supplier_variant_not_found",
      gate: null,
    };
  }

  // Live execution must use freshly verified supplier pricing/shipping.
  // Never fall back to stale PO economics after a live refresh fails to return a value.
  const sourceCost = price?.amount ?? null;
  const sourceCurrency = (price?.currency ?? shipping?.currency ?? "").toString().toUpperCase() || null;
  const shippingCurrency = shipping?.currency?.toString().toUpperCase() || null;
  let shippingCost = shipping?.amount ?? null;

  // The gate accepts one supplier-currency bucket for cost + shipping.
  // Normalize shipping into the supplier price currency instead of ever
  // adding unlike currencies.
  if (
    shippingCost !== null &&
    shippingCurrency &&
    sourceCurrency &&
    shippingCurrency !== sourceCurrency
  ) {
    const shippingFx = await resolveFxRate(shippingCurrency, sourceCurrency);
    shippingCost = shippingFx === null ? null : shippingCost * shippingFx;
  }

  const sellingCurrency = asString(shopOrderRow.currency)?.toUpperCase() ?? null;
  const fxQuote = await resolveFxRate(sourceCurrency, sellingCurrency);
  const inventoryQty = inventory?.quantity ?? null;
  const liveOrderingEnabled = isSupplierLiveOrderingEnabled(supplierName);
  const configured = isSupplierConfigured(supplierName);

  const gate = evaluateDropshipOrderGate({
    vid: supplierVariantId,
    quantity: asNumber(po.qty),
    sourceCost,
    shippingCost,
    currency: sourceCurrency,
    sellingPrice: asNumber(itemRow.unit_price),
    sourceFxRateToSelling: fxQuote,
    addressComplete: addressComplete(shopOrderRow),
    killSwitchBlocked: killSwitch.blocked,
    supplierConfigured: configured,
    cjConfigured: configured,
    liveOrderingEnabled,
    inventoryQty,
    duplicateOrderExists,
  });

  // Never place a live supplier order without a known selling price.
  // The order gate must remain fail-closed for profitability and FX checks.
  const executionMissing = gate.missing;
  const canExecuteLive =
    executionMissing.length === 0 &&
    gate.blocked.length === 0 &&
    !gate.liveOrderingDisabled;

  const { error: refreshPersistError } = await supabase
    .from("purchase_orders")
    .update({
      unit_cost: sourceCost,
      shipping_cost: shippingCost,
      currency: sourceCurrency,
      metadata: {
        ...((po.metadata as Record<string, unknown>) ?? {}),
        live_supplier_refresh: {
          observed_at: new Date().toISOString(),
          supplier: supplierName,
          product_id: supplierProductId,
          variant_id: supplierVariantId,
          inventory: inventoryQty,
          price: sourceCost,
          shipping: shippingCost,
          currency: sourceCurrency,
        },
        gate,
      },
    })
    .eq("id", purchaseOrderId);

  // Do not create an external supplier order if the authoritative live
  // refresh could not be persisted. Otherwise the external side effect could
  // succeed while TRACER loses the evidence needed to reconcile it safely.
  if (refreshPersistError) {
    return {
      purchaseOrderId,
      supplierName,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason: "supplier_refresh_persist_failed",
      gate,
    };
  }

  if (!canExecuteLive) {
    return {
      purchaseOrderId,
      supplierName,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason:
        [
          ...gate.blocked,
          ...executionMissing,
        ].join(",") || "not_ready",
      gate,
    };
  }

  if (isSupplierDryRunEnabled()) {
    return {
      purchaseOrderId,
      supplierName,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason: "supplier_dry_run_enabled",
      gate,
    };
  }

  const autoOrdering = isSupplierAutoOrderingEnabled(supplierName);
  if (!po.human_confirmed_at && !autoOrdering) {
    return {
      purchaseOrderId,
      supplierName,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason: "human_confirmation_required",
      gate,
    };
  }

  const idempotencyKey =
    asString(po.idempotency_key) ?? `dropship:${purchaseOrderId}`;

  const { data: existingAttempt } = await supabase
    .from("supplier_order_attempts")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (existingAttempt?.supplier_order_id) {
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
      supplierName,
      attempted: false,
      succeeded: true,
      supplierOrderId: String(existingAttempt.supplier_order_id),
      reason: "deduped_existing_attempt",
      gate,
    };
  }

  if (existingAttempt?.state === "unknown" || (existingAttempt?.state === "completed" && !existingAttempt?.supplier_order_id)) {
    return {
      purchaseOrderId,
      supplierName,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason: "supplier_attempt_outcome_unknown_manual_reconciliation_required",
      gate,
    };
  }

  const orderInput: SupplierOrderInput = {
    supplierName,
    orderNumber: idempotencyKey,
    supplierProductId,
    supplierVariantId,
    quantity: asNumber(po.qty) ?? 1,
    shippingCountryCode: asString(shopOrderRow.shipping_country_code) ?? "",
    shippingProvince: asString(shopOrderRow.shipping_province) ?? "",
    shippingCity: asString(shopOrderRow.shipping_city) ?? "",
    shippingAddress: asString(shopOrderRow.shipping_line1 ?? shopOrderRow.shipping_address) ?? "",
    shippingAddress2: asString(shopOrderRow.shipping_line2) ?? undefined,
    shippingZip: asString(shopOrderRow.shipping_zip) ?? "",
    shippingPhone: asString(shopOrderRow.customer_phone) ?? "",
    shippingCustomerName: asString(shopOrderRow.customer_name) ?? "",
    shippingCountry:
      asString(shopOrderRow.shipping_country) ??
      asString(shopOrderRow.shipping_country_code) ??
      "",
    email: asString(shopOrderRow.customer_email) ?? undefined,
    supplierPayload: (po.metadata as Record<string, unknown> | null)?.supplier_order_payload,
  };

  if (adapter.validateOrderInput) {
    const validation = await adapter.validateOrderInput(orderInput);
    if (!validation.valid) {
      return {
        purchaseOrderId,
        supplierName,
        attempted: false,
        succeeded: false,
        supplierOrderId: null,
        reason: validation.responseMessage ?? validation.responseCode,
        gate,
      };
    }
  }

  let attemptId: string | null = existingAttempt?.id ? String(existingAttempt.id) : null;

  if (existingAttempt?.state === "in_progress") {
    return {
      purchaseOrderId,
      supplierName,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason: "supplier_attempt_in_progress",
      gate,
    };
  }

  if (!attemptId) {
    const { data: attempt, error: attemptError } = await supabase
      .from("supplier_order_attempts")
      .insert({
        purchase_order_id: purchaseOrderId,
        idempotency_key: idempotencyKey,
        request_summary: {
          supplier: supplierName,
          supplier_product_id: supplierProductId,
          supplier_variant_id: supplierVariantId,
          quantity: asNumber(po.qty),
          shipping_country_code: asString(shopOrderRow.shipping_country_code),
        },
        state: "in_progress",
      })
      .select("id")
      .single();

    if (attemptError) {
      if (attemptError.code === "23505") {
        return {
          purchaseOrderId,
          supplierName,
          attempted: false,
          succeeded: false,
          supplierOrderId: null,
          reason: "supplier_attempt_claim_race_retry",
          gate,
        };
      }
      throw new Error(attemptError.message);
    }
    attemptId = attempt?.id ? String(attempt.id) : null;
  }

  if (!attemptId) {
    return {
      purchaseOrderId,
      supplierName,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason: "supplier_attempt_id_missing",
      gate,
    };
  }

  let result;
  try {
    result = await adapter.createOrder(orderInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase
      .from("supplier_order_attempts")
      .update({
        response_code: "EXCEPTION",
        response_message: message,
        succeeded: false,
        state: "unknown",
      })
      .eq("id", attemptId);

    return {
      purchaseOrderId,
      supplierName,
      attempted: true,
      succeeded: false,
      supplierOrderId: null,
      reason: `supplier_order_outcome_unknown_manual_reconciliation_required:${message}`,
      gate,
    };
  }

  // A response without a supplier order ID is ambiguous: the supplier may have
  // accepted the order even if its response was incomplete. Never mark that
  // outcome as safely retryable, because a second createOrder call could
  // create a duplicate shipment.
  const state = result.succeeded && result.supplierOrderId ? "completed" : "unknown";
  const { error: attemptUpdateError } = await supabase
    .from("supplier_order_attempts")
    .update({
      response_code: result.responseCode,
      response_message: result.responseMessage,
      supplier_order_id: result.supplierOrderId,
      succeeded: result.succeeded && Boolean(result.supplierOrderId),
      state,
    })
    .eq("id", attemptId);

  if (attemptUpdateError) {
    return {
      purchaseOrderId,
      supplierName,
      attempted: true,
      succeeded: false,
      supplierOrderId: null,
      reason: "supplier_attempt_record_update_failed_manual_reconciliation_required",
      gate,
    };
  }

  if (result.succeeded && result.supplierOrderId) {
    const { error: purchaseOrderUpdateError } = await supabase
      .from("purchase_orders")
      .update({
        supplier_order_id: result.supplierOrderId,
        live_order: true,
        supplier_status: "created",
        supplier_synced_at: new Date().toISOString(),
        status: "placed",
        metadata: {
          ...((po.metadata as Record<string, unknown>) ?? {}),
          supplier_order: {
            supplier: supplierName,
            supplier_order_id: result.supplierOrderId,
            response_code: result.responseCode,
          },
        },
      })
      .eq("id", purchaseOrderId);

    if (purchaseOrderUpdateError) {
      return {
        purchaseOrderId,
        supplierName,
        attempted: true,
        succeeded: true,
        supplierOrderId: result.supplierOrderId,
        reason: "supplier_order_created_db_sync_failed",
        gate,
      };
    }

    return {
      purchaseOrderId,
      supplierName,
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
        ...((po.metadata as Record<string, unknown>) ?? {}),
        supplier_error: result.responseMessage,
        supplier_response_code: result.responseCode,
      },
    })
    .eq("id", purchaseOrderId);

  return {
    purchaseOrderId,
    supplierName,
    attempted: true,
    succeeded: false,
    supplierOrderId: null,
    reason: result.responseMessage ?? "supplier_rejected",
    gate,
  };
}
