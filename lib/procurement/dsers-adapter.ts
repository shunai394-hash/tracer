import "server-only";

import { getDsersMcpConfig } from "@/lib/config/env";
import { createMcpToolConsumer } from "@/lib/sources/mcp/remote-client";
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

const SUPPLIER_NAME = "dsers";

function requireConsumer() {
  const { endpoint, accessToken } = getDsersMcpConfig();
  if (!accessToken) {
    throw new Error("DSERS_MCP_AUTH_REQUIRED: complete DSers OAuth 2.1/PKCE and configure the resulting access token");
  }
  return createMcpToolConsumer({
    endpoint,
    accessToken,
    clientName: "tracer",
    clientVersion: "0.1.0",
  });
}

async function requireTool(name: string) {
  const consumer = requireConsumer();
  const tools = await consumer.listTools();
  if (!tools.some((tool) => tool.name === name)) {
    throw new Error(`DSERS_MCP_TOOL_UNAVAILABLE: ${name}`);
  }
  return consumer;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractText(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  for (const item of value) {
    const record = readRecord(item);
    if (record?.type === "text" && typeof record.text === "string") {
      try { return JSON.parse(record.text) as unknown; } catch { return record.text; }
    }
  }
  return value;
}

function normalizeProduct(value: unknown): SupplierProduct | null {
  const root = readRecord(extractText(value));
  if (!root) return null;
  const product = readRecord(root.product) ?? root;
  const id = String(product.id ?? product.product_id ?? product.supplier_product_id ?? "").trim();
  const title = String(product.title ?? product.name ?? "").trim();
  if (!id || !title) return null;
  const inventory = typeof product.inventory === "number" ? product.inventory :
    typeof product.stock === "number" ? product.stock : null;
  const unitCost = typeof product.price === "number" ? product.price :
    typeof product.cost === "number" ? product.cost : null;
  return {
    supplierProductId: id,
    supplierName: SUPPLIER_NAME,
    title,
    currency: String(product.currency ?? "USD"),
    unitCost,
    shippingCost: null,
    available: inventory === null ? null : inventory > 0,
    orderable: inventory === null ? null : inventory > 0,
    trackingAvailable: null,
  };
}

function unsupported(operation: string): never {
  throw new Error(`DSERS_MCP_CONTRACT_UNVERIFIED: ${operation} remains fail-closed until the authenticated tool schema is observed`);
}

export const dsersSupplierAdapter: TracerSupplierAdapter = {
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
    payment: false,
    orderStatus: true,
    tracking: true,
    liveOrdering: false,
  },

  async search(query: string): Promise<SupplierProduct[]> {
    const consumer = await requireTool("search_supplier_products");
    const result = await consumer.callTool({
      name: "search_supplier_products",
      arguments: { query: query.trim() },
    });
    const parsed = extractText(result);
    const root = readRecord(parsed);
    const items = Array.isArray(root?.products) ? root.products : Array.isArray(parsed) ? parsed : [];
    return items.map(normalizeProduct).filter((p): p is SupplierProduct => p !== null);
  },

  async getProduct(supplierProductId: string) {
    const consumer = await requireTool("get_supplier_product");
    const result = await consumer.callTool({
      name: "get_supplier_product",
      arguments: { product_id: supplierProductId },
    });
    return normalizeProduct(result);
  },

  async getVariant(supplierProductId: string, supplierVariantId: string): Promise<SupplierVariant | null> {
    void supplierProductId;
    void supplierVariantId;
    unsupported("get_supplier_product variant mapping");
  },

  async getInventory(supplierProductId: string, supplierVariantId?: string): Promise<SupplierInventory | null> {
    void supplierProductId;
    void supplierVariantId;
    unsupported("inventory normalization");
  },

  async getPrice(supplierProductId: string, supplierVariantId?: string): Promise<SupplierPrice | null> {
    void supplierProductId;
    void supplierVariantId;
    unsupported("price normalization");
  },

  async getShipping(supplierProductId: string, supplierVariantId?: string): Promise<SupplierShipping | null> {
    const consumer = await requireTool("list_supplier_product_shipping_methods_and_cost");
    const result = await consumer.callTool({
      name: "list_supplier_product_shipping_methods_and_cost",
      arguments: {
        product_id: supplierProductId,
        variant_id: supplierVariantId,
      },
    });
    const parsed = extractText(result);
    const root = readRecord(parsed);
    const amount = typeof root?.amount === "number" ? root.amount :
      typeof root?.shipping_cost === "number" ? root.shipping_cost : null;
    const currency = typeof root?.currency === "string" ? root.currency : null;
    return {
      supplierProductId,
      supplierVariantId: supplierVariantId ?? null,
      amount,
      currency,
      available: amount !== null,
      observedAt: new Date().toISOString(),
    };
  },

  async createOrder(input: SupplierOrderInput): Promise<SupplierOrderResult> {
    void input;
    return {
      succeeded: false,
      supplierOrderId: null,
      responseCode: "DSERS_MCP_ORDER_CONTRACT_UNVERIFIED",
      responseMessage: "DSers order payload is fail-closed until the authenticated MCP tool schema is observed and mapped",
      trackingNumber: null,
      raw: null,
    };
  },

  async getOrderStatus(supplierOrderId: string): Promise<SupplierOrder | null> {
    void supplierOrderId;
    unsupported("get order status");
  },

  async getTracking(supplierOrderId: string): Promise<SupplierTracking | null> {
    void supplierOrderId;
    unsupported("tracking normalization");
  },
};
