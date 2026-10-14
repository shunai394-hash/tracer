import "server-only";

import {
  getCJConfig,
  isCJAutoOrderingEnabled,
  isCJLiveOrderingEnabled,
} from "@/lib/config/env";
import {
  fetchCJVariantByVid,
  getCJFreightOptions,
  getCJProductDetail,
  searchCJProducts,
  type CJProductCandidate,
} from "@/lib/sources/cj";
import {
  createCJOrderV2,
  getCJOrderStatus,
  getCJTrackingInfo,
} from "@/lib/sources/cj/create-order";
import type {
  SupplierInventory,
  SupplierOrder,
  SupplierOrderInput,
  SupplierOrderResult,
  SupplierOrderValidation,
  SupplierPrice,
  SupplierProduct,
  SupplierShipping,
  SupplierShippingContext,
  SupplierTracking,
  SupplierVariant,
  TracerSupplierAdapter,
} from "@/lib/procurement/types";

const OBSERVED_AT = () => new Date().toISOString();

function positiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "CJ request failed";
}

function mapProduct(product: CJProductCandidate): SupplierProduct {
  return {
    supplierProductId: product.id,
    supplierName: "cj",
    title: product.title,
    currency: "USD",
    unitCost: positiveNumber(product.price),
    shippingCost: positiveNumber(product.shippingCost),
    // Product-level inventory is not sufficient for ordering a specific variant.
    // The exact variant's verified warehouse stock is checked separately.
    available: null,
    orderable: product.saleStatus === "3",
    trackingAvailable: true,
  };
}

function countryName(countryCode: string, explicit?: string): string | null {
  const supplied = explicit?.trim();
  if (supplied) return supplied;
  const code = countryCode.trim().toUpperCase();
  // TRACER's live dropship checkout currently targets Japan. Do not invent a
  // human-readable country name for destinations we have not verified.
  if (code === "JP") return "Japan";
  return null;
}

type FreightChoice = {
  countryCode: string;
  logisticName: string;
  shippingCost: number;
  arrivalTime: string | null;
};

async function chooseFreight(
  supplierProductId: string,
  supplierVariantId: string,
  destinationCountryCode: string,
  destinationPostalCode: string,
  quantity: number,
): Promise<FreightChoice | null> {
  const variant = await fetchCJVariantByVid(supplierVariantId);
  if (!variant || variant.productId !== supplierProductId) return null;
  if (!Number.isSafeInteger(quantity) || quantity < 1) return null;

  const warehouses = (variant.inventoryByCountry ?? [])
    .filter((item) => /^[A-Z]{2}$/.test(item.countryCode) && item.quantity >= quantity)
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 2);

  if (warehouses.length === 0) return null;

  const choices: FreightChoice[] = [];
  for (const warehouse of warehouses) {
    const options = await getCJFreightOptions(supplierVariantId, {
      startCountryCode: warehouse.countryCode,
      endCountryCode: destinationCountryCode,
      zip: destinationPostalCode,
      quantity,
    });
    for (const option of options) {
      if (
        option.logisticName.trim() &&
        Number.isFinite(option.shippingCost) &&
        option.shippingCost >= 0
      ) {
        choices.push({
          countryCode: warehouse.countryCode,
          logisticName: option.logisticName,
          shippingCost: option.shippingCost,
          arrivalTime: option.arrivalTime,
        });
      }
    }
  }

  return choices.sort((a, b) => a.shippingCost - b.shippingCost)[0] ?? null;
}

export const cjSupplierAdapter: TracerSupplierAdapter = {
  name: "cj",
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
    // Keep automatic/live ordering disabled unless both explicit production
    // flags are enabled and the CJ API key is configured.
    liveOrdering: Boolean(getCJConfig().apiKey) && isCJLiveOrderingEnabled() && isCJAutoOrderingEnabled(),
  },

  async getProduct(supplierProductId): Promise<SupplierProduct | null> {
    const id = supplierProductId.trim();
    if (!id) return null;
    const product = await getCJProductDetail(id);
    return product ? mapProduct(product) : null;
  },

  async search(query): Promise<SupplierProduct[]> {
    const result = await searchCJProducts(query, { page: 1, size: 20 });
    return result.products.map(mapProduct);
  },

  async getVariant(supplierProductId, supplierVariantId): Promise<SupplierVariant | null> {
    const productId = supplierProductId.trim();
    const variantId = supplierVariantId.trim();
    if (!productId || !variantId) return null;
    const variant = await fetchCJVariantByVid(variantId);
    if (!variant || variant.productId !== productId) return null;
    const price = positiveNumber(variant.sellPrice);
    const inventory = variant.inventory;
    return {
      supplierVariantId: variant.vid,
      supplierProductId: variant.productId,
      sku: variant.sku,
      title: variant.nameEn,
      price,
      currency: "USD",
      inventory,
      orderable: price !== null && inventory !== null && inventory > 0,
    };
  },

  async getInventory(supplierProductId, supplierVariantId): Promise<SupplierInventory | null> {
    const productId = supplierProductId.trim();
    const variantId = supplierVariantId?.trim() ?? "";
    if (!productId || !variantId) return null;
    const variant = await fetchCJVariantByVid(variantId);
    if (!variant || variant.productId !== productId) return null;
    const quantity = variant.inventory;
    return {
      supplierProductId: productId,
      supplierVariantId: variantId,
      quantity,
      available: quantity !== null && quantity > 0,
      observedAt: OBSERVED_AT(),
    };
  },

  async getPrice(supplierProductId, supplierVariantId): Promise<SupplierPrice | null> {
    const productId = supplierProductId.trim();
    const variantId = supplierVariantId?.trim() ?? "";
    if (!productId || !variantId) return null;
    const variant = await fetchCJVariantByVid(variantId);
    if (!variant || variant.productId !== productId) return null;
    return {
      supplierProductId: productId,
      supplierVariantId: variantId,
      amount: positiveNumber(variant.sellPrice),
      currency: "USD",
      observedAt: OBSERVED_AT(),
    };
  },

  async getShipping(
    supplierProductId,
    supplierVariantId,
    context?: SupplierShippingContext,
  ): Promise<SupplierShipping | null> {
    const productId = supplierProductId.trim();
    const variantId = supplierVariantId?.trim() ?? "";
    const countryCode = context?.destinationCountryCode?.trim().toUpperCase() ?? "";
    const postalCode = context?.destinationPostalCode?.trim() ?? "";
    const quantity = Math.floor(context?.quantity ?? 1);
    if (!productId || !variantId || !/^[A-Z]{2}$/.test(countryCode) || !postalCode || quantity < 1) return null;

    const freight = await chooseFreight(productId, variantId, countryCode, postalCode, quantity);
    return {
      supplierProductId: productId,
      supplierVariantId: variantId,
      amount: freight?.shippingCost ?? null,
      currency: "USD",
      available: freight !== null,
      observedAt: OBSERVED_AT(),
    };
  },

  async validateOrderInput(input: SupplierOrderInput): Promise<SupplierOrderValidation> {
    const required: Array<[string, string | undefined]> = [
      ["supplierProductId", input.supplierProductId],
      ["supplierVariantId", input.supplierVariantId],
      ["orderNumber", input.orderNumber],
      ["shippingCountryCode", input.shippingCountryCode],
      ["shippingProvince", input.shippingProvince],
      ["shippingCity", input.shippingCity],
      ["shippingAddress", input.shippingAddress],
      ["shippingZip", input.shippingZip],
      ["shippingCustomerName", input.shippingCustomerName],
    ];
    const missing = required.find(([, value]) => !value?.trim());
    if (missing) {
      return { valid: false, responseCode: "CJ_PREFLIGHT_INPUT_MISSING", responseMessage: `Missing ${missing[0]}` };
    }
    if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
      return { valid: false, responseCode: "CJ_PREFLIGHT_QUANTITY_INVALID", responseMessage: "Quantity must be a positive integer" };
    }
    if (!countryName(input.shippingCountryCode, input.shippingCountry)) {
      return { valid: false, responseCode: "CJ_PREFLIGHT_COUNTRY_UNSUPPORTED", responseMessage: "Destination country name is not verified" };
    }

    try {
      const variant = await fetchCJVariantByVid(input.supplierVariantId);
      if (!variant || variant.productId !== input.supplierProductId) {
        return { valid: false, responseCode: "CJ_PREFLIGHT_VARIANT_MISMATCH", responseMessage: "CJ variant does not belong to the requested product" };
      }
      if (!positiveNumber(variant.sellPrice) || variant.inventory === null || variant.inventory < input.quantity) {
        return { valid: false, responseCode: "CJ_PREFLIGHT_STOCK_OR_PRICE_UNVERIFIED", responseMessage: "Fresh verified CJ stock and price are required" };
      }
      const freight = await chooseFreight(
        input.supplierProductId,
        input.supplierVariantId,
        input.shippingCountryCode,
        input.shippingZip,
        input.quantity,
      );
      if (!freight) {
        return { valid: false, responseCode: "CJ_PREFLIGHT_SHIPPING_UNAVAILABLE", responseMessage: "No verified CJ warehouse has a shipping option for this destination" };
      }
      return {
        valid: true,
        responseCode: "CJ_PREFLIGHT_OK",
        responseMessage: `Verified variant, stock, and ${freight.logisticName} from ${freight.countryCode}`,
      };
    } catch (error) {
      return { valid: false, responseCode: "CJ_PREFLIGHT_FAILED", responseMessage: safeMessage(error) };
    }
  },

  async createOrder(input: SupplierOrderInput): Promise<SupplierOrderResult> {
    if (!isCJLiveOrderingEnabled() || !isCJAutoOrderingEnabled() || !getCJConfig().apiKey) {
      return {
        succeeded: false,
        supplierOrderId: null,
        responseCode: "CJ_LIVE_ORDERING_DISABLED",
        responseMessage: "CJ live and automatic ordering flags must both be explicitly enabled",
        raw: null,
      };
    }

    try {
      const variant = await fetchCJVariantByVid(input.supplierVariantId);
      if (!variant || variant.productId !== input.supplierProductId) {
        return { succeeded: false, supplierOrderId: null, responseCode: "CJ_VARIANT_MISMATCH", responseMessage: "CJ variant does not match the supplier product", raw: null };
      }
      if (variant.inventory === null || variant.inventory < input.quantity || !positiveNumber(variant.sellPrice)) {
        return { succeeded: false, supplierOrderId: null, responseCode: "CJ_STOCK_OR_PRICE_UNVERIFIED", responseMessage: "Fresh verified stock and price are required", raw: null };
      }
      const freight = await chooseFreight(
        input.supplierProductId,
        input.supplierVariantId,
        input.shippingCountryCode,
        input.shippingZip,
        input.quantity,
      );
      if (!freight) {
        return { succeeded: false, supplierOrderId: null, responseCode: "CJ_SHIPPING_UNAVAILABLE", responseMessage: "No verified CJ shipping route is available", raw: null };
      }
      const shippingCountry = countryName(input.shippingCountryCode, input.shippingCountry);
      if (!shippingCountry) {
        return { succeeded: false, supplierOrderId: null, responseCode: "CJ_COUNTRY_UNVERIFIED", responseMessage: "Destination country name is not verified", raw: null };
      }

      const result = await createCJOrderV2({
        orderNumber: input.orderNumber,
        shippingCountryCode: input.shippingCountryCode.toUpperCase(),
        shippingCountry,
        shippingProvince: input.shippingProvince,
        shippingCity: input.shippingCity,
        shippingAddress: input.shippingAddress,
        shippingAddress2: input.shippingAddress2,
        shippingZip: input.shippingZip,
        shippingPhone: input.shippingPhone,
        shippingCustomerName: input.shippingCustomerName,
        email: input.email,
        logisticName: freight.logisticName,
        fromCountryCode: freight.countryCode,
        payType: 2,
        products: [{ vid: variant.vid, quantity: input.quantity }],
      });
      const succeeded = result.succeeded && Boolean(result.supplierOrderId);
      return {
        succeeded,
        supplierOrderId: succeeded ? result.supplierOrderId : null,
        responseCode: result.responseCode ?? (succeeded ? "CJ_ORDER_CREATED" : "CJ_ORDER_CREATE_FAILED"),
        responseMessage: result.responseMessage ?? (succeeded ? "CJ order created; awaiting explicit payment confirmation" : "CJ did not confirm order creation"),
        trackingNumber: null,
        raw: result.raw,
      };
    } catch (error) {
      return {
        succeeded: false,
        supplierOrderId: null,
        responseCode: error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "CJ_ORDER_FAILED") : "CJ_ORDER_FAILED",
        responseMessage: safeMessage(error),
        trackingNumber: null,
        raw: null,
      };
    }
  },

  async getOrderStatus(supplierOrderId): Promise<SupplierOrder | null> {
    const id = supplierOrderId.trim();
    if (!id) return null;
    const status = await getCJOrderStatus(id);
    return {
      supplierOrderId: id,
      supplierName: "cj",
      status: status.status,
      paymentConfirmed: Boolean(status.paymentDate || (status.paymentDateTime && status.paymentDateTime > 0)),
      createdAt: null,
    };
  },

  async getTracking(supplierOrderId): Promise<SupplierTracking | null> {
    const id = supplierOrderId.trim();
    if (!id) return null;
    const status = await getCJOrderStatus(id);
    if (!status.trackingNumber) return null;
    const tracking = await getCJTrackingInfo(status.trackingNumber);
    if (!tracking) return null;
    return {
      supplierOrderId: id,
      trackingNumber: tracking.trackingNumber,
      carrier: tracking.carrier,
      trackingUrl: tracking.trackingUrl,
      shippedAt: tracking.shippedAt,
    };
  },
};
