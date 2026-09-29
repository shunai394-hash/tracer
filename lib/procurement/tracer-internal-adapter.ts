import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type {
  TracerSupplierAdapter,
  SupplierInventory,
  SupplierPrice,
  SupplierProduct,
  SupplierOrderResult,
  SupplierShipping,
  SupplierTracking,
  SupplierVariant,
} from "@/lib/procurement/types";

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function syncInternalInventoryProjection(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  internalVariantId: string,
  inventory: number,
): Promise<void> {
  const { data: catalogVariants, error: variantError } = await supabase
    .from("tracer_supply_variants")
    .update({
      inventory,
      orderable: inventory > 0,
      updated_at: new Date().toISOString(),
    })
    .eq("internal_supply_variant_id", internalVariantId)
    .select("catalog_id");

  if (variantError) throw new Error(variantError.message);

  const catalogIds = Array.from(
    new Set((catalogVariants ?? []).map((row) => String(row.catalog_id))),
  );

  if (catalogIds.length > 0) {
    const { error: catalogError } = await supabase
      .from("tracer_supply_catalog")
      .update({
        inventory,
        orderable: inventory > 0,
        status: inventory > 0 ? "ready" : "draft",
        updated_at: new Date().toISOString(),
      })
      .in("id", catalogIds);

    if (catalogError) throw new Error(catalogError.message);
  }

  const { error: listingError } = await supabase
    .from("shop_listings")
    .update({
      inventory,
      orderable: inventory > 0,
      updated_at: new Date().toISOString(),
    })
    .eq("supplier_name", "TRACER_INTERNAL")
    .eq("supplier_variant_id", internalVariantId);

  if (listingError) throw new Error(listingError.message);
}

async function loadVariant(productId: string, variantId: string) {
  const supabase = createSupabaseAdminClient();
  const { data: variant, error } = await supabase
    .from("internal_supply_variants")
    .select("*,internal_supply_products(*)")
    .eq("id", variantId)
    .eq("supply_product_id", productId)
    .eq("active", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!variant) return null;
  return variant as Record<string, unknown> & {
    internal_supply_products: Record<string, unknown> | null;
  };
}

export const tracerInternalSupplierAdapter: TracerSupplierAdapter = {
  name: "tracer_internal",
  capabilities: {
    catalog: true,
    variant: true,
    inventory: true,
    price: true,
    shipping: true,
    shippingRequiresDestination: false,
    orderPreflight: true,
    orderCreation: true,
    payment: true,
    orderStatus: true,
    tracking: true,
    liveOrdering: true,
  },

  async search(query: string): Promise<SupplierProduct[]> {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("internal_supply_products")
      .select("*")
      .eq("active", true)
      .ilike("title", `%${query.trim()}%`)
      .limit(20);
    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => ({
      supplierProductId: String(row.id),
      supplierName: "tracer_internal",
      title: String(row.title),
      currency: String(row.currency ?? "JPY"),
      unitCost: asNumber(row.cost),
      shippingCost: asNumber(row.shipping_cost),
      available: asNumber(row.inventory) !== null && (asNumber(row.inventory) ?? 0) > 0,
      orderable: row.active === true,
      trackingAvailable: row.tracking_available === true,
    }));
  },

  async getProduct(supplierProductId: string): Promise<SupplierProduct | null> {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("internal_supply_products")
      .select("*")
      .eq("id", supplierProductId)
      .eq("active", true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return {
      supplierProductId: String(data.id),
      supplierName: "tracer_internal",
      title: String(data.title),
      currency: String(data.currency ?? "JPY"),
      unitCost: asNumber(data.cost),
      shippingCost: asNumber(data.shipping_cost),
      available: asNumber(data.inventory) !== null && (asNumber(data.inventory) ?? 0) > 0,
      orderable: data.active === true,
      trackingAvailable: data.tracking_available === true,
    };
  },

  async getVariant(supplierProductId: string, supplierVariantId: string): Promise<SupplierVariant | null> {
    const row = await loadVariant(supplierProductId, supplierVariantId);
    if (!row) return null;
    const product = row.internal_supply_products ?? {};
    return {
      supplierVariantId: String(row.id),
      supplierProductId: String(row.supply_product_id),
      sku: asString(row.variant_sku),
      title: asString(row.title) ?? asString(product.title),
      price: asNumber(row.cost) ?? asNumber(product.cost),
      currency: asString(row.currency) ?? asString(product.currency) ?? "JPY",
      inventory: asNumber(row.inventory),
      orderable: row.orderable === true && row.active === true,
    };
  },

  async getInventory(supplierProductId: string, supplierVariantId?: string): Promise<SupplierInventory | null> {
    if (!supplierVariantId) return null;
    const row = await loadVariant(supplierProductId, supplierVariantId);
    if (!row) return null;
    const quantity = asNumber(row.inventory);
    return {
      supplierProductId,
      supplierVariantId,
      quantity,
      available: row.orderable === true && row.active === true && quantity !== null && quantity > 0,
      observedAt: new Date().toISOString(),
    };
  },

  async getPrice(supplierProductId: string, supplierVariantId?: string): Promise<SupplierPrice | null> {
    if (!supplierVariantId) return null;
    const row = await loadVariant(supplierProductId, supplierVariantId);
    if (!row) return null;
    const product = row.internal_supply_products ?? {};
    const amount = asNumber(row.cost) ?? asNumber(product.cost);
    return {
      supplierProductId,
      supplierVariantId,
      amount,
      currency: asString(row.currency) ?? asString(product.currency) ?? "JPY",
      observedAt: new Date().toISOString(),
    };
  },

  async getShipping(supplierProductId: string, supplierVariantId?: string): Promise<SupplierShipping | null> {
    if (!supplierVariantId) return null;
    const row = await loadVariant(supplierProductId, supplierVariantId);
    if (!row) return null;
    const product = row.internal_supply_products ?? {};
    const amount = asNumber(row.shipping_cost) ?? asNumber(product.shipping_cost);
    return {
      supplierProductId,
      supplierVariantId,
      amount,
      currency: asString(row.currency) ?? asString(product.currency) ?? "JPY",
      available: amount !== null,
      observedAt: new Date().toISOString(),
    };
  },

  async validateOrderInput(input) {
    if (!input.shippingCountryCode || !input.shippingCity || !input.shippingAddress || !input.shippingZip) {
      return {
        valid: false,
        responseCode: "ADDRESS_INCOMPLETE",
        responseMessage: "TRACER internal fulfillment requires a complete shipping address.",
      };
    }
    return { valid: true, responseCode: "OK", responseMessage: null };
  },

  async createOrder(input): Promise<SupplierOrderResult> {
    const supabase = createSupabaseAdminClient();
    const existing = await supabase
      .from("internal_fulfillment_orders")
      .select("id,status")
      .eq("order_number", input.orderNumber)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data?.id) {
      return {
        succeeded: true,
        supplierOrderId: String(existing.data.id),
        responseCode: "ALREADY_CREATED",
        responseMessage: "TRACER internal fulfillment order already exists.",
        trackingNumber: null,
        raw: existing.data,
      };
    }

    const row = await loadVariant(input.supplierProductId, input.supplierVariantId);
    if (!row) {
      return {
        succeeded: false,
        supplierOrderId: null,
        responseCode: "VARIANT_NOT_FOUND",
        responseMessage: "TRACER internal supply variant was not found.",
        trackingNumber: null,
        raw: null,
      };
    }

    const inventory = asNumber(row.inventory) ?? 0;
    if (inventory < input.quantity || row.orderable !== true || row.active !== true) {
      return {
        succeeded: false,
        supplierOrderId: null,
        responseCode: "INVENTORY_UNAVAILABLE",
        responseMessage: "TRACER internal supply inventory is insufficient or not orderable.",
        trackingNumber: null,
        raw: { inventory, requested: input.quantity },
      };
    }

    const purchaseOrderId = input.orderNumber.startsWith("dropship:")
      ? input.orderNumber.slice("dropship:".length)
      : null;
    if (!purchaseOrderId) {
      return {
        succeeded: false,
        supplierOrderId: null,
        responseCode: "PURCHASE_ORDER_ID_MISSING",
        responseMessage: "TRACER internal fulfillment requires the purchase-order id in the idempotency key.",
        trackingNumber: null,
        raw: null,
      };
    }

    // Reserve inventory atomically in Postgres. Concurrent executions cannot
    // reserve the same units.
    const reserved = await supabase.rpc("reserve_internal_supply_variant", {
      p_variant_id: input.supplierVariantId,
      p_quantity: input.quantity,
    });

    if (reserved.error) throw new Error(reserved.error.message);
    if (!reserved.data || reserved.data.length === 0) {
      return {
        succeeded: false,
        supplierOrderId: null,
        responseCode: "INVENTORY_RACE",
        responseMessage: "TRACER internal inventory changed during reservation; retry safely.",
        trackingNumber: null,
        raw: null,
      };
    }

    }

    const reservedInventory = asNumber(reserved.data[0]?.remaining_inventory);
    if (reservedInventory === null) {
      await supabase.rpc("release_internal_supply_variant", {
        p_variant_id: input.supplierVariantId,
        p_quantity: input.quantity,
      });
      return {
        succeeded: false,
        supplierOrderId: null,
        responseCode: "INVENTORY_PROJECTION_FAILED",
        responseMessage: "TRACER inventory reservation returned no remaining quantity.",
        trackingNumber: null,
        raw: reserved.data,
      };
    }

    try {
      await syncInternalInventoryProjection(
        supabase,
        input.supplierVariantId,
        reservedInventory,
      );
    } catch (error) {
      const released = await supabase.rpc("release_internal_supply_variant", {
        p_variant_id: input.supplierVariantId,
        p_quantity: input.quantity,
      });
      if (!released.error && released.data?.[0]?.restored_inventory !== undefined) {
        await syncInternalInventoryProjection(
          supabase,
          input.supplierVariantId,
          Number(released.data[0].restored_inventory),
        );
      }
      throw error;
    }

    const inserted = await supabase
      .from("internal_fulfillment_orders")
      .insert({
        purchase_order_id: purchaseOrderId,
        supply_product_id: input.supplierProductId,
        supply_variant_id: input.supplierVariantId,
        quantity: input.quantity,
        status: "reserved",
        customer_name: input.shippingCustomerName,
        shipping_country_code: input.shippingCountryCode,
        shipping_province: input.shippingProvince,
        shipping_city: input.shippingCity,
        shipping_line1: input.shippingAddress,
        shipping_line2: input.shippingAddress2 ?? null,
        shipping_zip: input.shippingZip,
        shipping_phone: input.shippingPhone,
        customer_email: input.email ?? null,
        order_number: input.orderNumber,
        metadata: { source: "tracer_internal" },
      })
      .select("id")
      .single();

    if (inserted.error) {
      const released = await supabase.rpc("release_internal_supply_variant", {
        p_variant_id: input.supplierVariantId,
        p_quantity: input.quantity,
      });
      if (!released.error && released.data?.[0]?.restored_inventory !== undefined) {
        await syncInternalInventoryProjection(
          supabase,
          input.supplierVariantId,
          Number(released.data[0].restored_inventory),
        );
      }
      if (inserted.error.code === "23505") {
        const retry = await supabase
          .from("internal_fulfillment_orders")
          .select("id")
          .eq("order_number", input.orderNumber)
          .maybeSingle();
        if (retry.data?.id) {
          return {
            succeeded: true,
            supplierOrderId: String(retry.data.id),
            responseCode: "ALREADY_CREATED",
            responseMessage: "TRACER internal fulfillment order already exists.",
            trackingNumber: null,
            raw: retry.data,
          };
        }
      }
      throw new Error(inserted.error.message);
    }

    return {
      succeeded: true,
      supplierOrderId: String(inserted.data.id),
      responseCode: "INTERNAL_ORDER_CREATED",
      responseMessage: "TRACER internal fulfillment order reserved.",
      trackingNumber: null,
      raw: inserted.data,
    };
  },

  async getOrderStatus(supplierOrderId: string) {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("internal_fulfillment_orders")
      .select("id,status,created_at")
      .eq("id", supplierOrderId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return {
      supplierOrderId: String(data.id),
      supplierName: "tracer_internal",
      status: String(data.status),
      createdAt: String(data.created_at),
    };
  },

  async getTracking(supplierOrderId: string): Promise<SupplierTracking | null> {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("internal_fulfillment_orders")
      .select("id,tracking_number,carrier,tracking_url,status")
      .eq("id", supplierOrderId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return {
      supplierOrderId: String(data.id),
      trackingNumber: asString(data.tracking_number),
      carrier: asString(data.carrier),
      trackingUrl: asString(data.tracking_url),
      shippedAt: String(data.status) === "shipped" ? new Date().toISOString() : null,
    };
  },
};
