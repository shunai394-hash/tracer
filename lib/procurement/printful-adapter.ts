import "server-only";

import {
  getPrintfulOrder,
  getPrintfulProduct,
  getPrintfulShippingRate,
  getPrintfulVariant,
  searchPrintfulProducts,
} from "@/lib/sources/printful/client";
import type {
  SupplierInventory,
  SupplierOrder,
  SupplierOrderInput,
  SupplierOrderResult,
  SupplierPrice,
  SupplierProduct,
  SupplierShipping,
  SupplierTracking,
  SupplierVariant,
  TracerSupplierAdapter,
} from "@/lib/procurement/types";

const SUPPLIER_NAME = "printful";

function productFrom(value: Awaited<ReturnType<typeof getPrintfulProduct>>): SupplierProduct | null {
  if (!value) return null;
  const firstVariant = value.variants[0] ?? null;
  return {
    supplierProductId: value.id,
    supplierName: SUPPLIER_NAME,
    title: value.title,
    currency: firstVariant?.currency ?? value.currency,
    unitCost: firstVariant?.price ?? null,
    shippingCost: null,
    available: value.discontinued ? false : firstVariant?.inStock ?? null,
    orderable: value.discontinued ? false : firstVariant?.inStock ?? null,
    trackingAvailable: true,
  };
}

function variantFrom(
  value: Awaited<ReturnType<typeof getPrintfulVariant>>,
): SupplierVariant | null {
  if (!value) return null;
  return {
    supplierVariantId: value.id,
    supplierProductId: value.productId,
    sku: value.sku,
    title: value.title,
    price: value.price,
    currency: value.currency,
    inventory: value.inventory,
    orderable: value.inStock === null ? null : value.inStock,
  };
}

export const printfulSupplierAdapter: TracerSupplierAdapter = {
  name: SUPPLIER_NAME,
  capabilities: {
    catalog: true,
    variant: true,
    inventory: true,
    price: true,
    shipping: true,
    shippingRequiresDestination: true,
    orderPreflight: false,
    orderCreation: false,
    orderStatus: true,
    tracking: true,
    liveOrdering: false,
  },

  async search(query: string): Promise<SupplierProduct[]> {
    const products = await searchPrintfulProducts(query);
    return products.map((product) => ({
      supplierProductId: product.id,
      supplierName: SUPPLIER_NAME,
      title: product.title,
      currency: product.currency,
      unitCost: null,
      shippingCost: null,
      available: product.discontinued ? false : null,
      orderable: product.discontinued ? false : null,
      trackingAvailable: true,
    }));
  },

  async getProduct(supplierProductId: string) {
    return productFrom(await getPrintfulProduct(supplierProductId));
  },

  async getVariant(
    supplierProductId: string,
    supplierVariantId: string,
  ): Promise<SupplierVariant | null> {
    const variant = variantFrom(await getPrintfulVariant(supplierVariantId));
    if (!variant || variant.supplierProductId !== supplierProductId) return null;
    return variant;
  },

  async getInventory(
    supplierProductId: string,
    supplierVariantId?: string,
  ): Promise<SupplierInventory | null> {
    const variant = variantFrom(
      await getPrintfulVariant(supplierVariantId ?? ""),
    );
    if (!variant || variant.supplierProductId !== supplierProductId) return null;

    return {
      supplierProductId,
      supplierVariantId: variant.supplierVariantId,
      quantity: variant.inventory,
      available: variant.inStock,
      observedAt: new Date().toISOString(),
    };
  },

  async getPrice(
    supplierProductId: string,
    supplierVariantId?: string,
  ): Promise<SupplierPrice | null> {
    const variant = variantFrom(
      await getPrintfulVariant(supplierVariantId ?? ""),
    );
    if (!variant || variant.supplierProductId !== supplierProductId) return null;

    return {
      supplierProductId,
      supplierVariantId: variant.supplierVariantId,
      amount: variant.price,
      currency: variant.currency,
      observedAt: new Date().toISOString(),
    };
  },

  async getShipping(
    supplierProductId: string,
    supplierVariantId?: string,
    context?: { destinationCountryCode?: string; destinationPostalCode?: string; quantity?: number },
  ): Promise<SupplierShipping | null> {
    void supplierProductId;
    void context?.destinationPostalCode;

    const variantId = supplierVariantId ?? "";
    const country = context?.destinationCountryCode ?? "";
    const rate = await getPrintfulShippingRate(variantId, country, context?.quantity ?? 1);
    if (!rate) return null;

    return {
      supplierProductId,
      supplierVariantId: variantId || null,
      amount: rate.amount,
      currency: rate.currency,
      available: true,
      observedAt: new Date().toISOString(),
    };
  },

  async createOrder(input: SupplierOrderInput): Promise<SupplierOrderResult> {
    void input;
    return {
      succeeded: false,
      supplierOrderId: null,
      responseCode: "PRINTFUL_ORDER_CONTRACT_UNVERIFIED",
      responseMessage:
        "Printful order creation remains fail-closed because the generic Tracer order input has no verified design/printfiles contract required by Printful catalog orders",
      trackingNumber: null,
      raw: null,
    };
  },

  async getOrderStatus(supplierOrderId: string): Promise<SupplierOrder | null> {
    const order = await getPrintfulOrder(supplierOrderId);
    if (!order) return null;
    return {
      supplierOrderId: order.id,
      supplierName: SUPPLIER_NAME,
      status: order.status,
      createdAt: order.createdAt,
    };
  },

  async getTracking(supplierOrderId: string): Promise<SupplierTracking | null> {
    const order = await getPrintfulOrder(supplierOrderId);
    if (!order || !order.trackingNumber) return null;
    return {
      supplierOrderId: order.id,
      trackingNumber: order.trackingNumber,
      carrier: order.carrier,
      trackingUrl: order.trackingUrl,
      shippedAt: order.shippedAt,
    };
  },
};
