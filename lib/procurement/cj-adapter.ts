import "server-only";

import { createCJOrderV2, getCJOrderStatus } from "@/lib/sources/cj/create-order";
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

const SUPPLIER_NAME = "cj";

export const cjSupplierAdapter: TracerSupplierAdapter = {
  name: SUPPLIER_NAME,

  async search(_query: string): Promise<SupplierProduct[]> {
    return [];
  },

  async getProduct(_supplierProductId: string): Promise<SupplierProduct | null> {
    return null;
  },

  async getVariant(
    _supplierProductId: string,
    supplierVariantId: string,
  ): Promise<SupplierVariant | null> {
    if (!supplierVariantId) return null;

    return {
      supplierVariantId,
      supplierProductId: _supplierProductId,
      sku: supplierVariantId,
      title: null,
      price: null,
      currency: "USD",
      inventory: null,
      orderable: null,
    };
  },

  async getInventory(
    _supplierProductId: string,
    _supplierVariantId?: string,
  ): Promise<SupplierInventory | null> {
    return null;
  },

  async getPrice(
    _supplierProductId: string,
    _supplierVariantId?: string,
  ): Promise<SupplierPrice | null> {
    return null;
  },

  async getShipping(
    _supplierProductId: string,
    _supplierVariantId?: string,
  ): Promise<SupplierShipping | null> {
    return null;
  },

  async createOrder(input: SupplierOrderInput): Promise<SupplierOrderResult> {
    const result = await createCJOrderV2({
      orderNumber: input.orderNumber,
      shippingCountryCode: input.shippingCountryCode,
      shippingProvince: input.shippingProvince,
      shippingCity: input.shippingCity,
      shippingAddress: input.shippingAddress,
      shippingZip: input.shippingZip,
      shippingPhone: input.shippingPhone,
      shippingCustomerName: input.shippingCustomerName,
      products: [
        {
          vid: input.supplierVariantId,
          quantity: input.quantity,
        },
      ],
    });

    return {
      succeeded: result.succeeded,
      supplierOrderId: result.supplierOrderId,
      responseCode: result.responseCode ?? "CJ_UNKNOWN",
      responseMessage: result.responseMessage,
      trackingNumber: null,
      raw: result.raw,
    };
  },

  async getOrderStatus(supplierOrderId: string): Promise<SupplierOrder | null> {
    const result = await getCJOrderStatus(supplierOrderId);

    return {
      supplierOrderId,
      supplierName: SUPPLIER_NAME,
      status: result.status,
      createdAt: null,
    };
  },

  async getTracking(supplierOrderId: string): Promise<SupplierTracking | null> {
    const result = await getCJOrderStatus(supplierOrderId);

    if (!result.trackingNumber) {
      return null;
    }

    return {
      supplierOrderId,
      trackingNumber: result.trackingNumber,
      carrier: null,
      trackingUrl: null,
      shippedAt: null,
    };
  },
};

