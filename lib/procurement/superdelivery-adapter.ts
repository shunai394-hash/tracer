import "server-only";

import {
  getSuperDeliveryProduct,
  searchSuperDeliveryProducts,
  type SuperDeliveryProductSet,
} from "@/lib/sources/superdelivery/client";
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

const SUPPLIER_NAME = "superdelivery";

function toProduct(item: SuperDeliveryProductSet): SupplierProduct | null {
  const id = item.sdProductCode ?? item.makerProductCode;
  if (!id || !item.title) return null;
  return {
    supplierProductId: id,
    supplierName: SUPPLIER_NAME,
    title: item.title,
    currency: "JPY",
    unitCost: item.price,
    shippingCost: null,
    available: item.stock === null ? null : item.stock > 0,
    orderable: item.stock === null ? null : item.stock > 0 && item.exhibitState === 2,
    trackingAvailable: null,
  };
}

async function product(productId: string): Promise<SuperDeliveryProductSet | null> {
  return getSuperDeliveryProduct(productId);
}

export const superDeliverySupplierAdapter: TracerSupplierAdapter = {
  name: SUPPLIER_NAME,
  capabilities: {
    catalog: true,
    variant: true,
    inventory: true,
    price: true,
    shipping: false,
    shippingRequiresDestination: true,
    orderPreflight: false,
    orderCreation: false,
    payment: false,
    orderStatus: false,
    tracking: false,
    liveOrdering: false,
  },

  async search(query: string): Promise<SupplierProduct[]> {
    const items = await searchSuperDeliveryProducts(query);
    return items.map(toProduct).filter((item): item is SupplierProduct => item !== null);
  },

  async getProduct(supplierProductId: string): Promise<SupplierProduct | null> {
    const item = await product(supplierProductId);
    return item ? toProduct(item) : null;
  },

  async getVariant(supplierProductId: string, supplierVariantId: string): Promise<SupplierVariant | null> {
    const item = await product(supplierProductId);
    if (!item) return null;
    const variantId = item.setNo ?? item.sdProductCode ?? supplierVariantId;
    if (supplierVariantId !== variantId && supplierVariantId !== item.setNo) return null;
    return {
      supplierVariantId: variantId,
      supplierProductId: supplierProductId,
      sku: item.makerProductCode,
      title: item.title,
      price: item.price,
      currency: "JPY",
      inventory: item.stock,
      orderable: item.stock === null ? null : item.stock > 0 && item.exhibitState === 2,
    };
  },

  async getInventory(supplierProductId: string, supplierVariantId?: string): Promise<SupplierInventory | null> {
    const item = await product(supplierProductId);
    if (!item) return null;
    return {
      supplierProductId,
      supplierVariantId: supplierVariantId ?? item.setNo ?? item.sdProductCode,
      quantity: item.stock,
      available: item.stock === null ? null : item.stock > 0 && item.exhibitState === 2,
      observedAt: new Date().toISOString(),
    };
  },

  async getPrice(supplierProductId: string, supplierVariantId?: string): Promise<SupplierPrice | null> {
    const item = await product(supplierProductId);
    if (!item) return null;
    return {
      supplierProductId,
      supplierVariantId: supplierVariantId ?? item.setNo ?? item.sdProductCode,
      amount: item.price,
      currency: "JPY",
      observedAt: new Date().toISOString(),
    };
  },

  async getShipping(supplierProductId: string, supplierVariantId?: string): Promise<SupplierShipping | null> {
    void supplierProductId;
    void supplierVariantId;
    return {
      supplierProductId,
      supplierVariantId: supplierVariantId ?? null,
      amount: null,
      currency: "JPY",
      available: null,
      observedAt: new Date().toISOString(),
    };
  },

  async createOrder(input: SupplierOrderInput): Promise<SupplierOrderResult> {
    void input;
    return {
      succeeded: false,
      supplierOrderId: null,
      responseCode: "SUPERDELIVERY_ORDER_API_UNVERIFIED",
      responseMessage: "SUPER DELIVERY ordering remains fail-closed until an authenticated ordering API contract is verified",
      trackingNumber: null,
      raw: null,
    };
  },

  async getOrderStatus(supplierOrderId: string): Promise<SupplierOrder | null> {
    void supplierOrderId;
    return null;
  },

  async getTracking(supplierOrderId: string): Promise<SupplierTracking | null> {
    void supplierOrderId;
    return null;
  },
};
