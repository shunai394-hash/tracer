import "server-only";

import { createCJOrderV2, getCJOrderStatus } from "@/lib/sources/cj/create-order";
import { calculateCJFreight, fetchCJVariantByVid, fetchCJVariantStock } from "@/lib/sources/cj/client";
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
    supplierProductId: string,
    supplierVariantId: string,
  ): Promise<SupplierVariant | null> {
    if (!supplierVariantId) return null;
    const variant = await fetchCJVariantByVid(supplierVariantId);
    if (!variant) return null;

    return {
      supplierVariantId: variant.vid,
      supplierProductId: variant.productId || supplierProductId,
      sku: variant.sku,
      title: variant.nameEn,
      price: variant.sellPrice === null ? null : Number(variant.sellPrice),
      currency: "USD",
      inventory: null,
      orderable: null,
    };
  },

  async getInventory(
    supplierProductId: string,
    supplierVariantId?: string,
  ): Promise<SupplierInventory | null> {
    if (!supplierVariantId) return null;
    const inventory = await fetchCJVariantStock(supplierVariantId);
    return {
      supplierProductId,
      supplierVariantId,
      quantity: inventory,
      available: inventory !== null ? inventory > 0 : null,
    };
  },

  async getPrice(
    supplierProductId: string,
    supplierVariantId?: string,
  ): Promise<SupplierPrice | null> {
    if (!supplierVariantId) return null;
    const variant = await fetchCJVariantByVid(supplierVariantId);
    if (!variant || variant.sellPrice === null) return null;
    return {
      supplierProductId,
      supplierVariantId,
      amount: Number(variant.sellPrice),
      currency: "USD",
    };
  },

  async getShipping(
    supplierProductId: string,
    supplierVariantId?: string,
  ): Promise<SupplierShipping | null> {
    if (!supplierVariantId) return null;
    const amount = await calculateCJFreight(supplierVariantId, {
      startCountryCode: "CN",
      endCountryCode: "JP",
      quantity: 1,
    });
    if (amount === null) return null;
    return {
      supplierProductId,
      supplierVariantId,
      amount,
      currency: "USD",
      destinationCountryCode: "JP",
    };
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

