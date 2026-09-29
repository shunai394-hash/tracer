import "server-only";

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

export const tracerTestSupplier: TracerSupplierAdapter = {
  name: "TRACER_TEST",
  capabilities: {
    catalog: false,
    variant: false,
    inventory: false,
    price: false,
    shipping: false,
    shippingRequiresDestination: false,
    orderPreflight: false,
    orderCreation: false,
    orderStatus: false,
    tracking: false,
    liveOrdering: false,
  },

  async search(): Promise<SupplierProduct[]> {
    return [];
  },

  async getProduct(
    supplierProductId: string,
  ): Promise<SupplierProduct | null> {
    if (!supplierProductId.trim()) {
      return null;
    }

    return {
      supplierProductId,
      supplierName: "TRACER_TEST",
      title: "TRACER Test Product",
      currency: "JPY",
      unitCost: null,
      shippingCost: null,
      available: false,
      orderable: false,
      trackingAvailable: false,
    };
  },

  async getVariant(): Promise<SupplierVariant | null> {
    return null;
  },

  async getInventory(): Promise<SupplierInventory | null> {
    return null;
  },

  async getPrice(): Promise<SupplierPrice | null> {
    return null;
  },

  async getShipping(): Promise<SupplierShipping | null> {
    return null;
  },

  async createOrder(): Promise<SupplierOrderResult> {
    return {
      succeeded: false,
      supplierOrderId: null,
      responseCode: "TEST_ONLY",
      responseMessage: "TRACER test supplier does not place real orders",
      trackingNumber: null,
      raw: null,
    };
  },

  async getOrderStatus() {
    return null;
  },

  async getTracking(): Promise<SupplierTracking | null> {
    return null;
  },
};
