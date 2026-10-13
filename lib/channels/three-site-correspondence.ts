/**
 * TRACER ↔ BASE ↔ Shopify correspondence. TRACER (shop_listings) is the
 * master; each channel product is tied to one listing only by the external ID
 * stored on that listing, never by title or SKU. This module compares what the
 * channels actually hold against the master and lists every disagreement.
 *
 * Pure module: no network, database, or path-alias imports.
 */
import { isJapaneseProductTitle } from "../intelligence/japanese-product.ts";

export type CorrespondenceListing = {
  id: string;
  title: unknown;
  selling_price: unknown;
  inventory: unknown;
  published: unknown;
  base_item_id: unknown;
  shopify_product_id: unknown;
  shopify_variant_id: unknown;
};

export type CorrespondenceBaseItem = {
  item_id: unknown;
  identifier?: unknown;
  title: unknown;
  price: unknown;
  stock: unknown;
  visible: unknown;
};

export type CorrespondenceShopifyProduct = {
  id: string;
  title: string | null;
  status: string | null;
  publishedOnPublication: boolean | null;
  variants: Array<{ id: string; sku: string | null; price: string | null; inventoryQuantity: number | null }>;
};

export type ChannelSide = {
  externalId: string | null;
  found: boolean;
  title: string | null;
  price: number | null;
  stock: number | null;
  live: boolean | null;
};

export type CorrespondenceRow = {
  listingId: string;
  tracer: { title: string | null; price: number | null; inventory: number | null; published: boolean };
  base: ChannelSide;
  shopify: ChannelSide;
  issues: string[];
  /** Both external IDs exist, both products exist, and title/price/visibility agree everywhere. */
  consistent: boolean;
};

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Shopify IDs may be stored as a GID or a legacy numeric id; compare the tail. */
export function shopifyIdTail(value: unknown): string | null {
  const s = text(value);
  if (!s) return null;
  return s.split("/").pop() || null;
}

function normalizeTitle(value: string | null): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function baseVisible(value: unknown): boolean | null {
  if (value === 1 || value === "1" || value === true) return true;
  if (value === 0 || value === "0" || value === false) return false;
  return null;
}

export function buildThreeSiteCorrespondence(input: {
  listings: CorrespondenceListing[];
  baseItems: CorrespondenceBaseItem[];
  shopifyProducts: CorrespondenceShopifyProduct[];
}) {
  const baseById = new Map<string, CorrespondenceBaseItem>();
  for (const item of input.baseItems) {
    const id = text(item.item_id);
    if (id) baseById.set(id, item);
  }
  const shopifyById = new Map<string, CorrespondenceShopifyProduct>();
  for (const product of input.shopifyProducts) {
    const tail = shopifyIdTail(product.id);
    if (tail) shopifyById.set(tail, product);
  }

  // External IDs claimed by more than one TRACER listing are never trusted.
  const baseClaims = new Map<string, number>();
  const shopifyClaims = new Map<string, number>();
  for (const listing of input.listings) {
    const b = text(listing.base_item_id);
    if (b) baseClaims.set(b, (baseClaims.get(b) ?? 0) + 1);
    const s = shopifyIdTail(listing.shopify_product_id);
    if (s) shopifyClaims.set(s, (shopifyClaims.get(s) ?? 0) + 1);
  }

  const rows: CorrespondenceRow[] = input.listings.map((listing) => {
    const issues: string[] = [];
    const tracer = {
      title: text(listing.title),
      price: num(listing.selling_price),
      inventory: num(listing.inventory),
      published: listing.published === true,
    };

    const baseId = text(listing.base_item_id);
    const baseItem = baseId ? baseById.get(baseId) : undefined;
    const base: ChannelSide = {
      externalId: baseId,
      found: Boolean(baseItem),
      title: baseItem ? text(baseItem.title) : null,
      price: baseItem ? num(baseItem.price) : null,
      stock: baseItem ? num(baseItem.stock) : null,
      live: baseItem ? (baseVisible(baseItem.visible) === true && (num(baseItem.stock) ?? 0) > 0) : null,
    };

    const shopifyTail = shopifyIdTail(listing.shopify_product_id);
    const product = shopifyTail ? shopifyById.get(shopifyTail) : undefined;
    const variantTail = shopifyIdTail(listing.shopify_variant_id);
    // Never infer a variant from array order. Missing or stale variant IDs must fail closed.
    const variant = product && variantTail
      ? product.variants.find((v) => shopifyIdTail(v.id) === variantTail)
      : undefined;
    const shopify: ChannelSide = {
      externalId: text(listing.shopify_product_id),
      found: Boolean(product),
      title: product ? text(product.title) : null,
      price: variant ? num(variant.price) : null,
      stock: variant ? num(variant.inventoryQuantity) : null,
      live: product ? (product.status === "ACTIVE" && product.publishedOnPublication === true) : null,
    };

    if (!baseId) issues.push("base_id_missing");
    else if (!baseItem) issues.push("base_item_not_found");
    if (!shopifyTail) issues.push("shopify_id_missing");
    else if (!product) issues.push("shopify_product_not_found");
    else if (!variantTail) issues.push("shopify_variant_id_missing");
    else if (!variant) issues.push("shopify_variant_not_found");
    if (baseId && (baseClaims.get(baseId) ?? 0) > 1) issues.push("base_id_shared_by_listings");
    if (shopifyTail && (shopifyClaims.get(shopifyTail) ?? 0) > 1) issues.push("shopify_id_shared_by_listings");

    for (const [name, side] of [["base", base], ["shopify", shopify]] as const) {
      if (!side.found) continue;
      if (side.title !== null && !isJapaneseProductTitle(side.title)) issues.push(`${name}_title_not_japanese`);
      if (tracer.price !== null && side.price !== null && side.price !== tracer.price) issues.push(`${name}_price_mismatch`);
      if (side.live === true && !tracer.published) issues.push(`${name}_live_but_tracer_unpublished`);
      if (side.live === false && tracer.published) issues.push(`${name}_not_live_but_tracer_published`);
      if (side.live === true && (tracer.inventory === null || tracer.inventory <= 0)) issues.push(`${name}_live_without_tracer_stock`);
      if (tracer.inventory !== null && side.stock !== null && side.live === true && side.stock > tracer.inventory) issues.push(`${name}_stock_exceeds_tracer`);
    }
    if (base.found && shopify.found) {
      if (normalizeTitle(base.title) !== normalizeTitle(shopify.title)) issues.push("title_differs_between_channels");
      if (base.price !== null && shopify.price !== null && base.price !== shopify.price) issues.push("price_differs_between_channels");
      if (base.stock !== null && shopify.stock !== null && base.stock !== shopify.stock) issues.push("inventory_differs_between_channels");
      if (base.live !== null && shopify.live !== null && base.live !== shopify.live) issues.push("visibility_differs_between_channels");
    }

    const unique = Array.from(new Set(issues));
    return { listingId: listing.id, tracer, base, shopify, issues: unique, consistent: unique.length === 0 };
  });

  const linkedBase = new Set(rows.map((row) => row.base.externalId).filter((id): id is string => Boolean(id)));
  const linkedShopify = new Set(rows.map((row) => shopifyIdTail(row.shopify.externalId)).filter((id): id is string => Boolean(id)));
  const unlinkedBaseItems = input.baseItems
    .map((item) => ({ itemId: text(item.item_id), identifier: text(item.identifier), visible: baseVisible(item.visible) === true }))
    .filter((item): item is { itemId: string; identifier: string | null; visible: boolean } => Boolean(item.itemId) && !linkedBase.has(item.itemId as string));
  const unlinkedShopifyProducts = input.shopifyProducts
    .filter((product) => !linkedShopify.has(shopifyIdTail(product.id) ?? ""))
    .map((product) => ({ productId: product.id, live: product.status === "ACTIVE" && product.publishedOnPublication === true }));

  // Two channel products that carry the same TRACER key are duplicates.
  const baseIdentifierCounts = new Map<string, number>();
  for (const item of input.baseItems) {
    const id = text(item.identifier);
    if (id && id.startsWith("TRC-")) baseIdentifierCounts.set(id, (baseIdentifierCounts.get(id) ?? 0) + 1);
  }
  const shopifySkuCounts = new Map<string, number>();
  for (const product of input.shopifyProducts) {
    for (const variant of product.variants) {
      const sku = text(variant.sku);
      if (sku) shopifySkuCounts.set(sku, (shopifySkuCounts.get(sku) ?? 0) + 1);
    }
  }

  const issueCounts: Record<string, number> = {};
  for (const row of rows) for (const issue of row.issues) issueCounts[issue] = (issueCounts[issue] ?? 0) + 1;

  return {
    rows,
    unlinkedBaseItems,
    unlinkedShopifyProducts,
    summary: {
      tracerListings: rows.length,
      tracerPublished: rows.filter((row) => row.tracer.published).length,
      linkedToBoth: rows.filter((row) => row.base.found && row.shopify.found).length,
      linkedBaseOnly: rows.filter((row) => row.base.found && !row.shopify.found).length,
      linkedShopifyOnly: rows.filter((row) => !row.base.found && row.shopify.found).length,
      linkedToNeither: rows.filter((row) => !row.base.found && !row.shopify.found).length,
      consistent: rows.filter((row) => row.consistent).length,
      baseItems: input.baseItems.length,
      baseItemsLive: input.baseItems.filter((item) => baseVisible(item.visible) === true && (num(item.stock) ?? 0) > 0).length,
      unlinkedBaseItems: unlinkedBaseItems.length,
      unlinkedBaseItemsLive: unlinkedBaseItems.filter((item) => item.visible).length,
      shopifyTracerProducts: input.shopifyProducts.length,
      shopifyLive: input.shopifyProducts.filter((product) => product.status === "ACTIVE" && product.publishedOnPublication === true).length,
      unlinkedShopifyProducts: unlinkedShopifyProducts.length,
      unlinkedShopifyProductsLive: unlinkedShopifyProducts.filter((product) => product.live).length,
      duplicateBaseIdentifiers: [...baseIdentifierCounts.values()].filter((count) => count > 1).length,
      duplicateShopifySkus: [...shopifySkuCounts.values()].filter((count) => count > 1).length,
      issueCounts,
    },
  };
}
