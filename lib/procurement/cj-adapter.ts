import "server-only";

import {
  getCJConfig,
  isCJAutoOrderingEnabled,
  isCJLiveOrderingEnabled,
} from "@/lib/config/env";
import {
  fetchCJVariantByVid,
  fetchCJVariantStock,
  fetchCJProductVariants,
  getCJFreightOptions,
  getCJProductDetail,
  searchCJProducts,
  type CJProductCandidate,
} from "@/lib/sources/cj";
import {
  createCJOrderV2,
  confirmCJSandboxOrder,
  getCJOrderStatus,
  getCJTrackingInfo,
  simulateCJSandboxPayment,
  updateCJSandboxOrderStatus,
  updateCJSandboxTrackingNumber,
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
  const code = countryCode.trim().toUpperCase();
  const supplied = explicit?.trim();
  if (supplied && supplied.toUpperCase() !== code) return supplied;
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
  // queryByVid may omit warehouse-level inventory even when the dedicated
  // stock endpoint confirms stock. In that case, use CJ's documented CN
  // freight origin and require a live logistic quote; never invent a carrier.
  const sourceCountries = warehouses.length ? warehouses.map((warehouse) => warehouse.countryCode) : ["CN"];

  const choices: FreightChoice[] = [];
  for (const countryCode of sourceCountries) {
    const options = await getCJFreightOptions(supplierVariantId, {
      startCountryCode: countryCode,
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
          countryCode,
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
    // CJ balance-payment completion has not yet passed a live or sandbox
    // end-to-end test. Keep this capability false until that proof is recorded.
    payment: process.env.CJ_PAYMENT_FLOW_VERIFIED?.trim() === "1",
    orderStatus: true,
    tracking: true,
    // Keep automatic/live ordering disabled unless payment proof and both
    // explicit production flags are enabled and the CJ API key is configured.
    liveOrdering: Boolean(getCJConfig().apiKey) &&
      process.env.CJ_PAYMENT_FLOW_VERIFIED?.trim() === "1" &&
      isCJLiveOrderingEnabled() &&
      isCJAutoOrderingEnabled(),
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
      ["shippingPhone", input.shippingPhone],
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
    if (!isCJLiveOrderingEnabled() || !isCJAutoOrderingEnabled() || process.env.CJ_PAYMENT_FLOW_VERIFIED?.trim() !== "1" || !getCJConfig().apiKey) {
      return {
        succeeded: false,
        supplierOrderId: null,
        responseCode: "CJ_LIVE_ORDERING_DISABLED",
        responseMessage: "CJ live and automatic ordering flags plus verified payment flow must be explicitly enabled",
        trackingNumber: null,
        raw: null,
      };
    }

    try {
      const variant = await fetchCJVariantByVid(input.supplierVariantId);
      if (!variant || variant.productId !== input.supplierProductId) {
        return { succeeded: false, supplierOrderId: null, responseCode: "CJ_VARIANT_MISMATCH", responseMessage: "CJ variant does not match the supplier product", trackingNumber: null, raw: null };
      }
      if (variant.inventory === null || variant.inventory < input.quantity || !positiveNumber(variant.sellPrice)) {
        return { succeeded: false, supplierOrderId: null, responseCode: "CJ_STOCK_OR_PRICE_UNVERIFIED", responseMessage: "Fresh verified stock and price are required", trackingNumber: null, raw: null };
      }
      const freight = await chooseFreight(
        input.supplierProductId,
        input.supplierVariantId,
        input.shippingCountryCode,
        input.shippingZip,
        input.quantity,
      );
      if (!freight) {
        return { succeeded: false, supplierOrderId: null, responseCode: "CJ_SHIPPING_UNAVAILABLE", responseMessage: "No verified CJ shipping route is available", trackingNumber: null, raw: null };
      }
      const shippingCountry = countryName(input.shippingCountryCode, input.shippingCountry);
      if (!shippingCountry) {
        return { succeeded: false, supplierOrderId: null, responseCode: "CJ_COUNTRY_UNVERIFIED", responseMessage: "Destination country name is not verified", trackingNumber: null, raw: null };
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


/**
 * Runs the external CJ create → simulated payment → status → tracking lifecycle
 * against a CJ sandbox order. It does not use the live-order flags and never
 * writes purchase/order rows to TRACER's production database.
 */
export async function runCJSandboxOrderLifecycle(
  input: SupplierOrderInput,
  onOrderCreated?: (supplierOrderId: string) => Promise<void>,
): Promise<{
  supplierOrderId: string;
  status: string;
  trackingNumber: string;
  paymentConfirmed: true;
  sandbox: true;
  charged: false;
  realFulfillment: false;
  verifiedSupplierProductId: string;
  verifiedSupplierVariantId: string;
  verifiedUnitCostUsd: number;
  verifiedShippingCostUsd: number;
  verifiedInventory: number;
}> {
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
    ["shippingPhone", input.shippingPhone],
  ];
  const missing = required.find(([, value]) => !value?.trim());
  if (missing) throw new Error(`CJ_SANDBOX_INPUT_MISSING:${missing[0]}`);
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) throw new Error("CJ_SANDBOX_QUANTITY_INVALID");
  if (!countryName(input.shippingCountryCode, input.shippingCountry)) throw new Error("CJ_SANDBOX_COUNTRY_UNVERIFIED");

  const variant = await fetchCJVariantByVid(input.supplierVariantId);
  if (!variant) throw new Error(`CJ_SANDBOX_VARIANT_NOT_FOUND:vid=${input.supplierVariantId}`);
  if (variant.productId !== input.supplierProductId) {
    throw new Error(`CJ_SANDBOX_PRODUCT_ID_MISMATCH:expected=${input.supplierProductId}:actual=${variant.productId}:vid=${variant.vid}`);
  }
  // queryByVid can prove identity while omitting inventory or price fields.
  // Re-read the exact child under its canonical parent and use the dedicated
  // stock endpoint instead of treating missing embedded fields as zero.
  const [productVariants, liveInventory] = await Promise.all([
    fetchCJProductVariants(input.supplierProductId),
    fetchCJVariantStock(input.supplierVariantId),
  ]);
  const scopedVariant = productVariants.find((item) => item.vid === input.supplierVariantId);
  if (!scopedVariant || scopedVariant.productId !== input.supplierProductId) {
    throw new Error("CJ_SANDBOX_VARIANT_NOT_IN_LIVE_PRODUCT");
  }
  const verifiedUnitCostUsd = positiveNumber(variant.sellPrice) ?? positiveNumber(scopedVariant.sellPrice);
  if (liveInventory === null || liveInventory < input.quantity || !verifiedUnitCostUsd) {
    throw new Error("CJ_SANDBOX_STOCK_OR_PRICE_UNVERIFIED");
  }
  const freight = await chooseFreight(
    input.supplierProductId,
    input.supplierVariantId,
    input.shippingCountryCode,
    input.shippingZip,
    input.quantity,
  );
  if (!freight) throw new Error("CJ_SANDBOX_SHIPPING_UNAVAILABLE");
  const shippingCountry = countryName(input.shippingCountryCode, input.shippingCountry);
  if (!shippingCountry) throw new Error("CJ_SANDBOX_COUNTRY_UNVERIFIED");

  const created = await createCJOrderV2({
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
    payType: 3,
    isSandbox: true,
    products: [{ vid: variant.vid, quantity: input.quantity }],
  });
  const orderId = created.supplierOrderId?.trim();
  if (!created.succeeded || !orderId) throw new Error(`CJ_SANDBOX_CREATE_FAILED:${created.responseCode ?? "unknown"}`);
  // Persist the external order ID immediately so a later payment/status failure is reconcilable.
  if (onOrderCreated) await onOrderCreated(orderId);

  // payType=3 leaves the order in CREATED(100); confirmOrder moves it to UNPAID before sandbox payment.
  await confirmCJSandboxOrder(orderId);
  await simulateCJSandboxPayment(orderId);
  const trackingNumber = `SBXTRACER${Date.now()}`;
  await updateCJSandboxTrackingNumber(orderId, trackingNumber);
  await updateCJSandboxOrderStatus(orderId, 400);
  await updateCJSandboxOrderStatus(orderId, 500);

  const observed = await getCJOrderStatus(orderId);
  const normalizedStatus = (observed.status ?? "").trim().toUpperCase();
  const shipped = normalizedStatus === "500" || normalizedStatus === "SHIPPED" || normalizedStatus === "IN_TRANSIT";
  const paymentConfirmed = Boolean(observed.paymentDate || (observed.paymentDateTime && observed.paymentDateTime > 0));
  if (!paymentConfirmed || !shipped || observed.trackingNumber !== trackingNumber) {
    throw new Error("CJ_SANDBOX_LIFECYCLE_VERIFICATION_FAILED");
  }

  return {
    supplierOrderId: orderId,
    status: observed.status ?? "500",
    trackingNumber,
    paymentConfirmed: true,
    sandbox: true,
    charged: false,
    realFulfillment: false,
    verifiedSupplierProductId: variant.productId,
    verifiedSupplierVariantId: variant.vid,
    verifiedUnitCostUsd,
    verifiedShippingCostUsd: freight.shippingCost,
    verifiedInventory: liveInventory,
  };
}
