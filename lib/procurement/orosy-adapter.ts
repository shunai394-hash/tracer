import "server-only";

import {
  getOrosyProductDetail,
  getOrosyShippingQuote,
  orosyRequest,
  searchOrosyProducts,
  type OrosyProductDetail,
  type OrosyVariation,
} from "@/lib/sources/orosy";
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

const SUPPLIER_NAME = "orosy";

type OrosyOrderResponse = {
  order_id: string;
  status: string;
  created_at: string;
  groups?: Array<{
    shipments?: Array<{
      status?: string;
      shipped_at?: string | null;
      trackings?: Array<{
        tracking_no: string;
        carrier: string | null;
      }>;
    }>;
  }>;
};

function productFromDetail(
  detail: OrosyProductDetail,
  shippingCost: number | null,
): SupplierProduct {
  return {
    supplierProductId: detail.id,
    supplierName: SUPPLIER_NAME,
    title: detail.title,
    currency: detail.currency ?? "JPY",
    unitCost: detail.price,
    shippingCost,
    available: detail.inventory === null ? null : detail.inventory > 0,
    orderable: detail.orderable,
    trackingAvailable: null,
  };
}

function variationFor(
  detail: OrosyProductDetail,
  variantId?: string,
): OrosyVariation | null {
  if (variantId) {
    return detail.variations.find((variation) => variation.variationId === variantId) ?? null;
  }
  return detail.variations.length === 1 ? detail.variations[0] : null;
}

function variantFrom(
  detail: OrosyProductDetail,
  variation: OrosyVariation,
): SupplierVariant {
  return {
    supplierVariantId: variation.variationId,
    supplierProductId: detail.id,
    sku: null,
    title: variation.variantLabel,
    price: variation.buyerPrice,
    currency: variation.currency ?? detail.currency ?? "JPY",
    inventory: variation.stockQty,
    orderable:
      variation.stockQty === null ? null : variation.stockQty > 0 && detail.orderable,
  };
}

export const orosySupplierAdapter: TracerSupplierAdapter = {
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
    const products = await searchOrosyProducts(query);
    return products.map((product) => ({
      supplierProductId: product.id,
      supplierName: SUPPLIER_NAME,
      title: product.title,
      currency: product.currency ?? "JPY",
      unitCost: product.price,
      shippingCost: null,
      available: product.inventory === null ? null : product.inventory > 0,
      orderable: product.orderable,
      trackingAvailable: null,
    }));
  },

  async getProduct(supplierProductId: string): Promise<SupplierProduct | null> {
    const detail = await getOrosyProductDetail(supplierProductId);
    if (!detail) return null;
    const shipping = await getOrosyShippingQuote(detail.id);
    return productFromDetail(detail, shipping.amount);
  },

  async getVariant(
    supplierProductId: string,
    supplierVariantId: string,
  ): Promise<SupplierVariant | null> {
    const detail = await getOrosyProductDetail(supplierProductId);
    const variation = detail ? variationFor(detail, supplierVariantId) : null;
    return detail && variation ? variantFrom(detail, variation) : null;
  },

  async getInventory(
    supplierProductId: string,
    supplierVariantId?: string,
  ): Promise<SupplierInventory | null> {
    const detail = await getOrosyProductDetail(supplierProductId);
    const variation = detail ? variationFor(detail, supplierVariantId) : null;
    if (!detail || !variation) return null;
    return {
      supplierProductId: detail.id,
      supplierVariantId: variation.variationId,
      quantity: variation.stockQty,
      available:
        variation.stockQty === null ? null : variation.stockQty > 0 && detail.orderable,
      observedAt: new Date().toISOString(),
    };
  },

  async getPrice(
    supplierProductId: string,
    supplierVariantId?: string,
  ): Promise<SupplierPrice | null> {
    const detail = await getOrosyProductDetail(supplierProductId);
    const variation = detail ? variationFor(detail, supplierVariantId) : null;
    if (!detail || !variation) return null;
    return {
      supplierProductId: detail.id,
      supplierVariantId: variation.variationId,
      amount: variation.buyerPrice,
      currency: variation.currency ?? detail.currency ?? "JPY",
      observedAt: new Date().toISOString(),
    };
  },

  async getShipping(
    supplierProductId: string,
    supplierVariantId?: string,
  ): Promise<SupplierShipping | null> {
    const detail = await getOrosyProductDetail(supplierProductId);
    const variation = detail ? variationFor(detail, supplierVariantId) : null;
    if (!detail || !variation) return null;
    const quote = await getOrosyShippingQuote(detail.id);
    return {
      supplierProductId: detail.id,
      supplierVariantId: variation.variationId,
      amount: quote.amount,
      currency: quote.currency,
      available: quote.unresolved ? null : quote.amount !== null,
      observedAt: new Date().toISOString(),
    };
  },

  async createOrder(input: SupplierOrderInput): Promise<SupplierOrderResult> {
    void input;
    return {
      succeeded: false,
      supplierOrderId: null,
      responseCode: "OROSY_ORDER_BLOCKED_CART_STATE",
      responseMessage:
        "OROSY order creation is blocked until the stateful cart flow is implemented and dry-run verified",
      trackingNumber: null,
      raw: null,
    };
  },

  async getOrderStatus(supplierOrderId: string): Promise<SupplierOrder | null> {
    const response = await orosyRequest<OrosyOrderResponse>(
      `/orders/${encodeURIComponent(supplierOrderId)}`,
    );
    return {
      supplierOrderId: response.order_id,
      supplierName: SUPPLIER_NAME,
      status: response.status ?? null,
      createdAt: response.created_at ?? null,
    };
  },

  async getTracking(supplierOrderId: string): Promise<SupplierTracking | null> {
    const response = await orosyRequest<OrosyOrderResponse>(
      `/orders/${encodeURIComponent(supplierOrderId)}`,
    );
    for (const group of response.groups ?? []) {
      for (const shipment of group.shipments ?? []) {
        const tracking = shipment.trackings?.[0];
        if (tracking?.tracking_no) {
          return {
            supplierOrderId: response.order_id,
            trackingNumber: tracking.tracking_no,
            carrier: tracking.carrier ?? null,
            trackingUrl: null,
            shippedAt: shipment.shipped_at ?? null,
          };
        }
      }
    }
    return null;
  },
};
