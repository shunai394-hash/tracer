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

    // Reserve inventory before creating the internal fulfillment record.
    // The conditional update makes concurrent executions fail closed.
    const updated = await supabase
      .from("internal_supply_variants")
      .update({ inventory: inventory - input.quantity, updated_at: new Date().toISOString() })
      .eq("id", input.supplierVariantId)
      .gte("inventory", input.quantity)
      .eq("active", true)
      .eq("orderable", true)
      .select("id")
      .maybeSingle();

    if (updated.error) throw new Error(updated.error.message);
    if (!updated.data) {
      return {
        succeeded: false,
        supplierOrderId: null,
        responseCode: "INVENTORY_RACE",
        responseMessage: "TRACER internal inventory changed during reservation; retry safely.",
        trackingNumber: null,
        raw: null,
      };
    }

    const inserted = await supabase
      .from("internal_fulfillment_orders")
      .insert({
        purchase_order_id: input.orderNumber.replace(/^dropship:/, ""),
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
      await supabase
        .from("internal_supply_variants")
        .update({ inventory: inventory, updated_at: new Date().toISOString() })
        .eq("id", input.supplierVariantId);
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
