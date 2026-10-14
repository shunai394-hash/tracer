import "server-only";

import { createCJOrderV2, getCJOrderStatus, getCJTrackingInfo } from "@/lib/sources/cj/create-order";
import { calculateCJFreight, fetchCJVariantByVid, fetchCJVariantStock, getCJFreightOptions, getCJProductDetail, searchCJProducts } from "@/lib/sources/cj/client";
import { extractCjPaymentConfirmation, preflightCjOrder, selectCjLogistic } from "@/lib/procurement/cj-order-policy";
import { isSupplierLiveOrderingEnabled } from "@/lib/config/env";
import type {
  SupplierInventory,
  SupplierOrder,
  SupplierOrderInput,
  SupplierOrderResult,
  SupplierOrderValidation,
  SupplierPrice,
  SupplierProduct,
  SupplierShipping,
  SupplierTracking,
  SupplierVariant,
  TracerSupplierAdapter,
} from "@/lib/procurement/types";

const SUPPLIER_NAME = "cj";

/**
 * CJdropshipping procurement for verified CN -> JP direct delivery.
 *
 * Real orders stay behind CJ_LIVE_ORDERING=1, SUPPLIER_DRY_RUN=0 and either a
 * human confirmation or CJ_AUTO_ORDERING=1 (see executeSupplierPurchaseOrder).
 * createOrderV2 uses balance payment (payType 2); a purchase order becomes
 * "placed" only after getOrderDetail reports an explicit payment.
 * An ambiguous create response is never retried here: the attempt row stays
 * "unknown" for manual reconciliation so a second CJ order cannot be created.
 */
export const cjSupplierAdapter: TracerSupplierAdapter = {
  name: SUPPLIER_NAME,
  capabilities: {
    catalog: true,
    variant: true,
    inventory: true,
    price: true,
    shipping: true,
    shippingRequiresDestination: true,
    orderPreflight: true,
    orderCreation: true,
    payment: true,
    orderStatus: true,
    tracking: true,
    // Reflects the real switch, so auto-procurement eligibility, inventory
    // refresh and dropship execution treat CJ as not live while it is off.
    get liveOrdering() {
      return isSupplierLiveOrderingEnabled(SUPPLIER_NAME);
    },
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

  async getVariant(supplierProductId: string, supplierVariantId: string): Promise<SupplierVariant | null> {
    if (!supplierVariantId) return null;
    const variant = await fetchCJVariantByVid(supplierVariantId);
    if (!variant) return null;
    // The purchase order's product and the CJ variant must agree exactly.
    if (variant.productId && variant.productId !== supplierProductId) return null;
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

  async getInventory(supplierProductId: string, supplierVariantId?: string): Promise<SupplierInventory | null> {
    if (!supplierVariantId) return null;
    const quantity = await fetchCJVariantStock(supplierVariantId);
    return {
      supplierProductId,
      supplierVariantId,
      quantity,
      available: quantity !== null ? quantity > 0 : null,
      observedAt: new Date().toISOString(),
    };
  },

  async getPrice(supplierProductId: string, supplierVariantId?: string): Promise<SupplierPrice | null> {
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

  async getShipping(supplierProductId, supplierVariantId, context): Promise<SupplierShipping | null> {
    if (!supplierVariantId) return null;
    const destinationCountryCode = context?.destinationCountryCode?.trim().toUpperCase();
    const quantity = context?.quantity ?? 1;
    if (!destinationCountryCode || quantity <= 0) return null;
    const amount = await calculateCJFreight(supplierVariantId, {
      startCountryCode: "CN",
      endCountryCode: destinationCountryCode,
      quantity,
      ...(context?.destinationPostalCode ? { zip: context.destinationPostalCode } : {}),
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

  async validateOrderInput(input: SupplierOrderInput): Promise<SupplierOrderValidation> {
    return preflightCjOrder(input);
  },

  async createOrder(input: SupplierOrderInput): Promise<SupplierOrderResult> {
    const preflight = preflightCjOrder(input);
    if (!preflight.valid) {
      return { succeeded: false, supplierOrderId: null, responseCode: preflight.responseCode, responseMessage: preflight.responseMessage, trackingNumber: null, raw: null };
    }
    // Everything below up to createCJOrderV2 is read-only, so a failure is a
    // definite "nothing was ordered" and the caller records an explicit rejection.
    const liveInventory = await fetchCJVariantStock(input.supplierVariantId).catch(() => null);
    if (liveInventory === null || liveInventory < input.quantity) {
      return {
        succeeded: false,
        supplierOrderId: null,
        responseCode: "CJ_INVENTORY_UNAVAILABLE",
        responseMessage: `available=${liveInventory ?? "unknown"} requested=${input.quantity}`,
        trackingNumber: null,
        raw: { liveInventory, requestedQuantity: input.quantity },
      };
    }
    let freightOptions: Awaited<ReturnType<typeof getCJFreightOptions>>;
    try {
      freightOptions = await getCJFreightOptions(input.supplierVariantId, {
        startCountryCode: "CN",
        endCountryCode: input.shippingCountryCode,
        zip: input.shippingZip,
        quantity: input.quantity,
      });
    } catch (error) {
      return {
        succeeded: false,
        supplierOrderId: null,
        responseCode: "CJ_LOGISTICS_LOOKUP_FAILED",
        responseMessage: error instanceof Error ? error.message : String(error),
        trackingNumber: null,
        raw: null,
      };
    }
    const logistic = selectCjLogistic(freightOptions);
    if (!logistic) {
      return {
        succeeded: false,
        supplierOrderId: null,
        responseCode: "CJ_LOGISTICS_UNAVAILABLE",
        responseMessage: "No CJ logistics option is available for this destination and variant",
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
      logisticName: logistic.logisticName,
      fromCountryCode: "CN",
      payType: 2,
      products: [{ vid: input.supplierVariantId, quantity: input.quantity }],
    });

    return {
      succeeded: result.succeeded,
      supplierOrderId: result.supplierOrderId,
      responseCode: result.responseCode ?? "CJ_UNKNOWN",
      responseMessage: result.responseMessage,
      trackingNumber: null,
      raw: { logistic, response: result.raw },
    };
  },

  async getOrderStatus(supplierOrderId: string): Promise<SupplierOrder | null> {
    const result = await getCJOrderStatus(supplierOrderId);
    return {
      supplierOrderId,
      supplierName: SUPPLIER_NAME,
      status: result.status,
      paymentConfirmed: extractCjPaymentConfirmation(result.raw),
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
