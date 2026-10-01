import "server-only";

import { createCJOrderV2, getCJOrderStatus, getCJTrackingInfo } from "@/lib/sources/cj/create-order";
import { calculateCJFreight, fetchCJProductInventory, fetchCJVariantByVid, fetchCJVariantStock, getCJProductDetail, searchCJProducts, getCJFreightOptions } from "@/lib/sources/cj/client";
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

function normalizePaymentState(value: unknown): "paid" | "unpaid" | "unknown" {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (["paid", "paymentcompleted", "paymentsuccess", "success", "completed"].includes(normalized)) return "paid";
  if (["unpaid", "pending", "paymentpending", "created", "unpay", "waitpay"].includes(normalized)) return "unpaid";
  return "unknown";
}

function extractCJPaymentConfirmation(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const root = raw as Record<string, unknown>;
  const data = root.data && typeof root.data === "object" ? root.data as Record<string, unknown> : null;
  const payment = data?.payment && typeof data.payment === "object" ? data.payment as Record<string, unknown> : null;
  const candidates = [
    data?.paymentStatus,
    data?.payStatus,
    data?.paymentState,
    data?.payState,
    payment?.status,
    payment?.paymentStatus,
  ];
  return candidates.some((value) => normalizePaymentState(value) === "paid");
}

export const cjSupplierAdapter: TracerSupplierAdapter = {
  name: SUPPLIER_NAME,
  capabilities: {
    catalog: true,
    variant: true,
    inventory: true,
    price: true,
    shipping: true,
    shippingRequiresDestination: true,
    orderPreflight: false,
    orderCreation: true,
    // CJ order creation/status are implemented, but supplier-side payment
    // completion is not yet verified end-to-end. Fail closed until it is.
    payment: false,
    orderStatus: true,
    tracking: true,
    liveOrdering: true,
  },

  async search(query: string): Promise<SupplierProduct[]> {
    const result = await searchCJProducts(query, { page: 1, size: 20 });
    return result.products.map((product) => ({
      supplierProductId: product.id,
      supplierName: SUPPLIER_NAME,
      title: product.title,
      currency: "USD",
      unitCost: product.price === null ? null : Number(product.price),
      shippingCost: product.shippingCost === null ? null : Number(product.shippingCost),
      available: product.inventory !== null ? product.inventory > 0 : null,
      orderable: product.inventory !== null ? product.inventory > 0 : null,
      trackingAvailable: true,
    }));
  },

  async getProduct(supplierProductId: string): Promise<SupplierProduct | null> {
    const product = await getCJProductDetail(supplierProductId);
    if (!product) return null;

    return {
      supplierProductId: product.id,
      supplierName: SUPPLIER_NAME,
      title: product.title,
      currency: "USD",
      unitCost: product.price === null ? null : Number(product.price),
      shippingCost: product.shippingCost === null ? null : Number(product.shippingCost),
      available: product.inventory !== null ? product.inventory > 0 : null,
      orderable: product.inventory !== null ? product.inventory > 0 : null,
      trackingAvailable: true,
    };
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
      observedAt: new Date().toISOString(),
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
      observedAt: new Date().toISOString(),
    };
  },

  async getShipping(
    supplierProductId: string,
    supplierVariantId?: string,
    context?: { destinationCountryCode?: string; destinationPostalCode?: string; quantity?: number },
  ): Promise<SupplierShipping | null> {
    if (!supplierVariantId) return null;
    const destinationCountryCode = context?.destinationCountryCode?.trim().toUpperCase();
    const quantity = context?.quantity ?? 1;
    if (!destinationCountryCode || quantity <= 0) return null;
    const amount = await calculateCJFreight(supplierVariantId, {
      startCountryCode: "CN",
      endCountryCode: destinationCountryCode,
      quantity,
    });
    if (amount === null) return null;
    return {
      supplierProductId,
      supplierVariantId,
      amount,
      currency: "USD",
      available: true,
      observedAt: new Date().toISOString(),
    };
  },

  async createOrder(input: SupplierOrderInput): Promise<SupplierOrderResult> {
    let liveInventory: number | null = null;
    try {
      liveInventory = await fetchCJVariantStock(input.supplierVariantId);
    } catch {
      liveInventory = null;
    }

    if (liveInventory === null) {
      liveInventory = await fetchCJProductInventory(input.supplierProductId);
    }

    if (liveInventory === null || liveInventory < input.quantity) {
      return {
        succeeded: false,
        supplierOrderId: null,
        responseCode: "CJ_INVENTORY_UNAVAILABLE",
        responseMessage: `CJ live inventory is insufficient for this order: available=${liveInventory ?? "unknown"} requested=${input.quantity}`,
        trackingNumber: null,
        raw: { liveInventory, requestedQuantity: input.quantity },
      };
    }

    const freightOptions = await getCJFreightOptions(input.supplierVariantId, {
      startCountryCode: "CN",
      endCountryCode: input.shippingCountryCode,
      zip: input.shippingZip,
      quantity: input.quantity,
    });
    const selectedLogistic = freightOptions[0]?.logisticName;
    if (!selectedLogistic) {
      return {
        succeeded: false,
        supplierOrderId: null,
        responseCode: "CJ_LOGISTICS_UNAVAILABLE",
        responseMessage: "No verified CJ logistics option is available for this destination and variant",
        trackingNumber: null,
        raw: { freightOptions },
      };
    }

    const result = await createCJOrderV2({
      orderNumber: input.orderNumber,
      shippingCountryCode: input.shippingCountryCode,
      shippingCountry: input.shippingCountry ?? input.shippingCountryCode,
      shippingProvince: input.shippingProvince,
      shippingCity: input.shippingCity,
      shippingAddress: input.shippingAddress,
      shippingAddress2: input.shippingAddress2,
      shippingZip: input.shippingZip,
      shippingPhone: input.shippingPhone,
      shippingCustomerName: input.shippingCustomerName,
      email: input.email,
      logisticName: selectedLogistic,
      fromCountryCode: "CN",
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
      paymentConfirmed: extractCJPaymentConfirmation(result.raw),
      createdAt: null,
    };
  },

  async getTracking(supplierOrderId: string): Promise<SupplierTracking | null> {
    const order = await getCJOrderStatus(supplierOrderId);
    if (!order.trackingNumber) return null;

    const tracking = await getCJTrackingInfo(order.trackingNumber);
    if (!tracking?.trackingNumber) return null;

    return {
      supplierOrderId,
      trackingNumber: tracking.lastMileTrackingNumber ?? tracking.trackingNumber,
      carrier: tracking.carrier,
      trackingUrl: tracking.trackingUrl,
      shippedAt: tracking.shippedAt,
    };
  },
};
