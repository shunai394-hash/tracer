import "server-only";

import { searchFaireProducts, getFaireProduct } from "@/lib/sources/faire/client";
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

const SUPPLIER_NAME = "faire";

function productFrom(value: Awaited<ReturnType<typeof getFaireProduct>>): SupplierProduct | null {
  if (!value) return null;
  return {
    supplierProductId: value.id,
    supplierName: SUPPLIER_NAME,
    title: value.title,
    currency: value.currency,
    unitCost: value.unitCost,
    shippingCost: null,
    available: value.inventory === null ? null : value.inventory > 0,
    orderable: value.orderable,
    trackingAvailable: null,
  };
}

export const faireSupplierAdapter: TracerSupplierAdapter = {
  name: SUPPLIER_NAME,

  async search(query: string): Promise<SupplierProduct[]> {
    const products = await searchFaireProducts(query);
    return products.map((product) => ({
      supplierProductId: product.id,
      supplierName: SUPPLIER_NAME,
      title: product.title,
      currency: product.currency,
      unitCost: product.unitCost,
      shippingCost: null,
      available: product.inventory === null ? null : product.inventory > 0,
      orderable: product.orderable,
      trackingAvailable: null,
    }));
  },

  async getProduct(supplierProductId: string) {
    return productFrom(await getFaireProduct(supplierProductId));
  },

  async getVariant(supplierProductId: string, supplierVariantId: string): Promise<SupplierVariant | null> {
    const product = await getFaireProduct(supplierProductId);
    if (!product || product.variantId !== supplierVariantId) return null;
    return {
      supplierVariantId,
      supplierProductId,
      sku: product.sku,
      title: product.title,
      price: product.unitCost,
      currency: product.currency,
      inventory: product.inventory,
      orderable: product.orderable,
    };
  },

  async getInventory(supplierProductId: string, supplierVariantId?: string): Promise<SupplierInventory | null> {
    const product = await getFaireProduct(supplierProductId);
    if (!product || (supplierVariantId && product.variantId !== supplierVariantId)) return null;
    return {
      supplierProductId,
      supplierVariantId: product.variantId,
      quantity: product.inventory,
      available: product.inventory === null ? null : product.inventory > 0,
      observedAt: new Date().toISOString(),
    };
  },

  async getPrice(supplierProductId: string, supplierVariantId?: string): Promise<SupplierPrice | null> {
    const product = await getFaireProduct(supplierProductId);
    if (!product || (supplierVariantId && product.variantId !== supplierVariantId)) return null;
    return {
      supplierProductId,
      supplierVariantId: product.variantId,
      amount: product.unitCost,
      currency: product.currency,
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
      currency: null,
      available: null,
      observedAt: new Date().toISOString(),
    };
  },

  async createOrder(input: SupplierOrderInput): Promise<SupplierOrderResult> {
    void input;
    return {
      succeeded: false,
      supplierOrderId: null,
      responseCode: "FAIRE_ORDER_CONTRACT_UNVERIFIED",
      responseMessage: "Faire retailer order payload is not enabled until the authenticated retailer API contract is verified",
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
