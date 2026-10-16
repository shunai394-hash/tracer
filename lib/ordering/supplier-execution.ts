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
import { persistOrderStateUpdate } from "@/lib/ordering/status-write";
import { checkKillSwitch } from "@/lib/ops/kill-switch";
import { isNativeCjSupplierListing } from "@/lib/catalog/canonical-supplier-identity";
import { isCJQuotaCircuitActive } from "@/lib/sources/cj/rate-limit-policy";
import { getObservedFxRate } from "@/lib/intelligence/fx";
import {
  evaluateDropshipOrderGate,
  isCjSupplierName,
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

  // CJ daily API-point exhaustion blocks all supplier refresh/order calls until
  // the persisted cooldown expires. Keep the paid customer order pending for a
  // safe retry instead of repeatedly calling a provider that cannot process it.
  if (isCjSupplierName(supplierName)) {
    const { data: quotaRun, error: quotaReadError } = await supabase
      .from("cron_runs")
      .select("metadata")
      .eq("job_name", "cj-api-quota-circuit")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (quotaReadError) {
      return {
        purchaseOrderId, supplierName, attempted: false, succeeded: false,
        supplierOrderId: null, reason: "supplier_quota_circuit_lookup_failed", gate: null,
      };
    }
    const quotaMetadata = quotaRun?.metadata && typeof quotaRun.metadata === "object" && !Array.isArray(quotaRun.metadata)
      ? quotaRun.metadata as Record<string, unknown>
      : {};
    if (isCJQuotaCircuitActive(quotaMetadata)) {
      const blockedUntil = typeof quotaMetadata.blockedUntil === "string" ? quotaMetadata.blockedUntil : null;
      return {
        purchaseOrderId, supplierName, attempted: false, succeeded: false,
        supplierOrderId: null, reason: blockedUntil ? `supplier_quota_cooldown_until:${blockedUntil}` : "supplier_quota_cooldown", gate: null,
      };
    }
  }

  // CJ supply discovery is not enough to authorize a customer-order purchase.
  // Require one exact supplier product+variant row, linked to this canonical product.
  // Lookup failures and duplicate rows fail closed before any supplier API call.
  if (isCjSupplierName(supplierName)) {
    const canonicalProductId = asString(po.product_id);
    const externalProductId = asString(po.supplier_product_id);
    const externalVariantId = asString(po.supplier_variant_id);
    if (!canonicalProductId || !externalProductId || !externalVariantId) {
      return {
        purchaseOrderId, supplierName, attempted: false, succeeded: false,
        supplierOrderId: null, reason: "supplier_identity_missing", gate: null,
      };
    }
    const { data: identityRows, error: identityError } = await supabase
      .from("supplier_listings")
      .select("id,product_id,supplier,identity_status,verification_status,shipping_status,configured,price_confirmed,inventory_confirmed,api_available,orderable,tracking_available,inventory,cost,shipping_cost,ship_to,supplier_product_id,supplier_variant_id,verification_error,last_verified_at")
      .eq("supplier", "cj")
      .eq("supplier_product_id", externalProductId)
      .eq("supplier_variant_id", externalVariantId)
      .limit(2);
    if (identityError) {
      return {
        purchaseOrderId, supplierName, attempted: false, succeeded: false,
        supplierOrderId: null, reason: "supplier_identity_lookup_failed", gate: null,
      };
    }
    const uniqueExactVariant = identityRows?.length === 1
      && String(identityRows[0]?.product_id ?? "") === canonicalProductId;
    const linkedCanonicalIdentity = uniqueExactVariant
      && identityRows?.[0]?.identity_status === "linked";
    // Standalone CJ products do not have marketplace identity_status=linked.
    // Permit them only when the exact supplier variant has fresh, verified
    // JP shipping, cost, stock, API orderability and tracking evidence.
    const verifiedNativeCjIdentity = uniqueExactVariant
      && identityRows?.[0]?.identity_status === "supply_discovered"
      && isNativeCjSupplierListing(identityRows[0] as Record<string, unknown>);
    if (!linkedCanonicalIdentity && !verifiedNativeCjIdentity) {
      return {
        purchaseOrderId, supplierName, attempted: false, succeeded: false,
        supplierOrderId: null, reason: "supplier_identity_unlinked_or_ambiguous", gate: null,
      };
    }
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
    ["orderPreflight", capabilities.orderPreflight],
    ["orderCreation", capabilities.orderCreation],
    ["payment", capabilities.payment],
    ["orderStatus", capabilities.orderStatus],
    ["tracking", capabilities.tracking],
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
  if (shopOrder && ["cancellation_requested", "refund_pending", "cancelled", "refunded"].includes(String(shopOrder.order_status))) {
    return {
      purchaseOrderId,
      supplierName,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason: `shop_order_${String(shopOrder.order_status)}`,
      gate: null,
    };
  }
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
  const supplierVariantId = asString(po.supplier_variant_id) ?? asString(itemRow.supplier_variant_id);

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

  const refreshedMetadata: Record<string, unknown> = {
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
  };
  const { error: refreshPersistError } = await supabase
    .from("purchase_orders")
    .update({
      unit_cost: sourceCost,
      shipping_cost: shippingCost,
      currency: sourceCurrency,
      metadata: refreshedMetadata,
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

  const { data: existingAttempt, error: existingAttemptError } = await supabase
    .from("supplier_order_attempts")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (existingAttemptError) {
    console.error("[TRACER SUPPLIER ATTEMPT LOOKUP FAILED]", {
      purchaseOrderId,
      supplierName,
      error: existingAttemptError.message,
    });
    return {
      purchaseOrderId,
      supplierName,
      attempted: false,
      succeeded: false,
      supplierOrderId: null,
      reason: "supplier_attempt_lookup_failed_manual_reconciliation_required",
      gate,
    };
  }

  if (existingAttempt?.supplier_order_id) {
    const syncResult = await persistOrderStateUpdate(
      { table: "purchase_orders", id: purchaseOrderId, purchaseOrderId, context: "dedupe_existing_supplier_order" },
      () => supabase
        .from("purchase_orders")
        .update({
          supplier_order_id: existingAttempt.supplier_order_id,
          live_order: true,
          supplier_status: "created",
          supplier_synced_at: new Date().toISOString(),
          // An existing supplier order is not a paid one. Only
          // executeVerifiedSupplierPurchaseOrder may move this to "placed"
          // after the supplier reports payment.
          status: "supplier_payment_pending",
        })
        .eq("id", purchaseOrderId),
    );
    if (!syncResult.ok) {
      return {
        purchaseOrderId,
        supplierName,
        attempted: false,
        succeeded: false,
        supplierOrderId: String(existingAttempt.supplier_order_id),
        reason: "deduped_supplier_order_status_sync_failed_manual_reconciliation_required",
        gate,
      };
    }

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

  // Re-read immediately before the external side effect. A customer cancellation
  // can arrive while live supplier validation is running; cancellation must win.
  if (po.shop_order_id) {
    const { data: latestShopOrder, error: latestShopOrderError } = await supabase
      .from("shop_orders")
      .select("order_status")
      .eq("id", po.shop_order_id)
      .maybeSingle();
    if (latestShopOrderError) {
      console.error("[TRACER ORDER CANCELLATION CHECK FAILED]", {
        purchaseOrderId,
        shopOrderId: po.shop_order_id,
        supplierAttemptId: attemptId,
        error: latestShopOrderError.message,
      });
      const checkFailureWrite = await persistOrderStateUpdate(
        { table: "supplier_order_attempts", id: attemptId, purchaseOrderId, context: "cancellation_check_failed" },
        () => supabase
          .from("supplier_order_attempts")
          .update({
            state: "unknown",
            response_code: "CANCELLATION_CHECK_FAILED",
            response_message: latestShopOrderError.message,
          })
          .eq("id", attemptId),
      );
      return {
        purchaseOrderId,
        supplierName,
        attempted: false,
        succeeded: false,
        supplierOrderId: null,
        reason: checkFailureWrite.ok
          ? "shop_order_cancellation_check_failed_manual_reconciliation_required"
          : "shop_order_cancellation_check_and_attempt_state_write_failed_manual_reconciliation_required",
        gate,
      };
    }
    if (latestShopOrder && ["cancellation_requested", "refund_pending", "cancelled", "refunded"].includes(String(latestShopOrder.order_status))) {
      const cancellationWrite = await persistOrderStateUpdate(
        { table: "supplier_order_attempts", id: attemptId, purchaseOrderId, context: "cancellation_before_supplier_execution" },
        () => supabase
          .from("supplier_order_attempts")
          .update({ state: "unknown", response_code: "CUSTOMER_CANCELLATION_REQUESTED", response_message: "Customer cancellation arrived before supplier execution." })
          .eq("id", attemptId),
      );
      if (!cancellationWrite.ok) {
        return {
          purchaseOrderId,
          supplierName,
          attempted: false,
          succeeded: false,
          supplierOrderId: null,
          reason: "cancellation_attempt_state_write_failed_manual_reconciliation_required",
          gate,
        };
      }
      return {
        purchaseOrderId,
        supplierName,
        attempted: false,
        succeeded: false,
        supplierOrderId: null,
        reason: "customer_cancellation_requested_before_supplier_execution",
        gate,
      };
    }
  }

  let result;
  try {
    result = await adapter.createOrder(orderInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureWrite = await persistOrderStateUpdate(
      { table: "supplier_order_attempts", id: attemptId, purchaseOrderId, context: "supplier_create_order_exception" },
      () => supabase
        .from("supplier_order_attempts")
        .update({
          response_code: "EXCEPTION",
          response_message: message,
          succeeded: false,
          state: "unknown",
        })
        .eq("id", attemptId),
    );

    return {
      purchaseOrderId,
      supplierName,
      attempted: true,
      succeeded: false,
      supplierOrderId: null,
      reason: failureWrite.ok
        ? `supplier_order_outcome_unknown_manual_reconciliation_required:${message}`
        : `supplier_order_outcome_unknown_and_attempt_state_write_failed_manual_reconciliation_required:${failureWrite.error}`,
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
    console.error("[TRACER SUPPLIER ATTEMPT RESULT WRITE FAILED]", {
      purchaseOrderId,
      supplierAttemptId: attemptId,
      error: attemptUpdateError.message,
    });
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
        // Order creation is not payment. executeVerifiedSupplierPurchaseOrder
        // promotes this to "placed" only after the supplier confirms payment.
        status: "supplier_payment_pending",
        metadata: {
          ...refreshedMetadata,
          supplier_order: {
            supplier: supplierName,
            supplier_order_id: result.supplierOrderId,
            response_code: result.responseCode,
          },
        },
      })
      .eq("id", purchaseOrderId);

    if (purchaseOrderUpdateError) {
      console.error("[TRACER PURCHASE ORDER STATUS WRITE FAILED]", {
        purchaseOrderId,
        supplierOrderId: result.supplierOrderId,
        error: purchaseOrderUpdateError.message,
      });
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

  const rejectedWrite = await persistOrderStateUpdate(
    { table: "purchase_orders", id: purchaseOrderId, purchaseOrderId, context: "supplier_rejected" },
    () => supabase
      .from("purchase_orders")
      .update({
        status: "supplier_rejected",
        metadata: {
          ...((po.metadata as Record<string, unknown>) ?? {}),
          supplier_error: result.responseMessage,
          supplier_response_code: result.responseCode,
        },
      })
      .eq("id", purchaseOrderId),
  );
  if (!rejectedWrite.ok) {
    return {
      purchaseOrderId,
      supplierName,
      attempted: true,
      succeeded: false,
      supplierOrderId: null,
      reason: "supplier_rejection_status_write_failed_manual_reconciliation_required",
      gate,
    };
  }

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
