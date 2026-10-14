import "server-only";
import { getShopifyConfig } from "@/lib/config/env";
import type { SupplierInventory, SupplierOrder, SupplierOrderInput, SupplierOrderResult, SupplierPrice, SupplierProduct, SupplierShipping, SupplierTracking, SupplierVariant, TracerSupplierAdapter } from "@/lib/procurement/types";

const NAME = "shopify_collective";
const TAG = "tracer-collective-approved";
type Meta = { namespace: string; key: string; value: string };
type Variant = { id: string; sku: string | null; title: string; inventoryQuantity: number; metafields: { nodes: Meta[] } };
type Product = { id: string; title: string; tags: string[]; metafields: { nodes: Meta[] }; variants: { nodes: Variant[] } };
const meta = (nodes: Meta[], key: string) => nodes.find(x => x.namespace === "tracer" && x.key === key)?.value ?? null;
const num = (value: string | null): number | null => { if (value === null || !value.trim()) return null; const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null; };
async function query<T>(queryText: string, variables: Record<string, unknown> = {}): Promise<T> {
  const c = getShopifyConfig();
  if (!c.storeDomain || !c.adminAccessToken) throw new Error("SHOPIFY_COLLECTIVE_CONFIG_REQUIRED");
  const host = c.storeDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const res = await fetch(`https://${host}/admin/api/${process.env.SHOPIFY_API_VERSION || "2026-07"}/graphql.json`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": c.adminAccessToken },
    body: JSON.stringify({ query: queryText, variables }), cache: "no-store",
  });
  if (!res.ok) throw new Error(`SHOPIFY_COLLECTIVE_HTTP_${res.status}`);
  const body = await res.json() as { data?: T; errors?: Array<{ message?: string }> };
  if (body.errors?.length || !body.data) throw new Error("SHOPIFY_COLLECTIVE_GRAPHQL_FAILED");
  return body.data;
}
const FIELDS = `id title tags metafields(first: 30, namespace: "tracer") { nodes { namespace key value } }
variants(first: 100) { nodes { id sku title inventoryQuantity metafields(first: 20, namespace: "tracer") { nodes { namespace key value } } } }`;
async function productById(id: string): Promise<Product | null> {
  const d = await query<{ product: Product | null }>(`query($id: ID!) { product(id: $id) { ${FIELDS} } }`, { id });
  const p = d.product;
  return p && p.tags.includes(TAG) && meta(p.metafields.nodes, "supplier_product_id") ? p : null;
}
function chosen(p: Product, variantId?: string): Variant | null {
  const list = p.variants.nodes.filter(v => meta(v.metafields.nodes, "supplier_variant_id") &&
    num(meta(v.metafields.nodes, "unit_cost")) !== null && num(meta(v.metafields.nodes, "shipping_cost")) !== null);
  return variantId ? list.find(v => v.id === variantId) ?? null : list.length === 1 ? list[0] : null;
}
function asProduct(p: Product, v: Variant): SupplierProduct {
  return { supplierProductId: p.id, supplierName: NAME, title: p.title,
    currency: meta(v.metafields.nodes, "currency") ?? "JPY",
    unitCost: num(meta(v.metafields.nodes, "unit_cost")), shippingCost: num(meta(v.metafields.nodes, "shipping_cost")),
    available: v.inventoryQuantity > 0, orderable: false, trackingAvailable: false };
}
async function get(pId: string, vId?: string) { const p = await productById(pId); if (!p) return null; const v = chosen(p, vId); return v ? { p, v } : null; }

export const shopifyCollectiveSupplierAdapter: TracerSupplierAdapter = {
  name: NAME,
  capabilities: { catalog: true, variant: true, inventory: true, price: true, shipping: true, shippingRequiresDestination: true,
    orderPreflight: false, orderCreation: false, payment: false, orderStatus: false, tracking: false, liveOrdering: false },
  async search(term: string): Promise<SupplierProduct[]> {
    const safe = term.trim().replace(/["']/g, " ").slice(0, 60);
    const d = await query<{ products: { nodes: Product[] } }>(
      `query($q: String!) { products(first: 50, query: $q) { nodes { ${FIELDS} } } }`,
      { q: `tag:${TAG} ${safe}` });
    return d.products.nodes.filter(p => p.tags.includes(TAG) && meta(p.metafields.nodes, "supplier_product_id"))
      .flatMap(p => { const v = p.variants.nodes.find(x => chosen(p, x.id)); return v ? [asProduct(p, v)] : []; });
  },
  async getProduct(id: string) { const p = await productById(id); if (!p) return null; const v = chosen(p); return v ? asProduct(p, v) : null; },
  async getVariant(pid: string, vid: string): Promise<SupplierVariant | null> {
    const x = await get(pid, vid); if (!x) return null;
    return { supplierProductId: pid, supplierVariantId: vid, sku: x.v.sku, title: x.v.title,
      price: num(meta(x.v.metafields.nodes, "unit_cost")), currency: meta(x.v.metafields.nodes, "currency") ?? "JPY",
      inventory: x.v.inventoryQuantity, orderable: false };
  },
  async getInventory(pid: string, vid?: string): Promise<SupplierInventory | null> {
    const x = await get(pid, vid); return x ? { supplierProductId: pid, supplierVariantId: x.v.id, quantity: x.v.inventoryQuantity,
      available: x.v.inventoryQuantity > 0, observedAt: new Date().toISOString() } : null;
  },
  async getPrice(pid: string, vid?: string): Promise<SupplierPrice | null> {
    const x = await get(pid, vid); return x ? { supplierProductId: pid, supplierVariantId: x.v.id,
      amount: num(meta(x.v.metafields.nodes, "unit_cost")), currency: meta(x.v.metafields.nodes, "currency") ?? "JPY",
      observedAt: new Date().toISOString() } : null;
  },
  async getShipping(pid: string, vid?: string): Promise<SupplierShipping | null> {
    const x = await get(pid, vid); if (!x) return null; const amount = num(meta(x.v.metafields.nodes, "shipping_cost"));
    return { supplierProductId: pid, supplierVariantId: x.v.id, amount, currency: meta(x.v.metafields.nodes, "currency") ?? "JPY",
      available: amount !== null, observedAt: new Date().toISOString() };
  },
  async createOrder(input: SupplierOrderInput): Promise<SupplierOrderResult> {
    void input;
    return { succeeded: false, supplierOrderId: null, responseCode: "SHOPIFY_COLLECTIVE_ORDERING_NOT_VERIFIED",
      responseMessage: "Supplier-side order/payment is not verified; no order was placed.", trackingNumber: null, raw: null };
  },
  async getOrderStatus(id: string): Promise<SupplierOrder | null> { void id; return null; },
  async getTracking(id: string): Promise<SupplierTracking | null> { void id; return null; },
};
