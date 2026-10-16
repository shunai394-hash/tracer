/**
 * Pure comparison of a Shopify catalog scan with TRACER's two link tables.
 * Keeps the populations separate: the whole store, products with vendor
 * TRACER, commerce channel_listings and legacy shop_listings. Counts are
 * labelled EXACT only when the scan reached the last page.
 */

export type ShopifyCatalogNode = {
  id: string;
  handle: string;
  status: string;
  vendor: string | null;
  publishedOnPublication: boolean;
  variants: Array<{ id: string; sku: string | null; price: string | null }>;
};

export type CommerceShopifyRow = {
  variant_id: string;
  external_product_id: string | null;
  external_variant_id: string | null;
  external_sku: string | null;
  status: string;
  selling_price: number | string | null;
};

export type LegacyShopifyRow = { id: string; shopify_product_id: string | null };

const tail = (id: unknown) => String(id ?? "").split("/").pop() ?? "";
const LEGACY_SKU = /^TRC-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMERCE_SKU = /^TRC-[0-9a-f]{24}$/i;

export function reconcileShopifyCatalog(input: {
  nodes: ShopifyCatalogNode[];
  scanComplete: boolean;
  commerceRows: CommerceShopifyRow[];
  legacyRows: LegacyShopifyRow[];
  probeVariantIds?: string[];
}) {
  const { nodes, scanComplete, commerceRows, legacyRows } = input;
  const live = (node: ShopifyCatalogNode) => node.status === "ACTIVE" && node.publishedOnPublication;
  const byProduct = new Map(nodes.map((node) => [tail(node.id), node]));
  const commerceProductIds = new Set(commerceRows.map((row) => tail(row.external_product_id)).filter(Boolean));
  const legacyProductIds = new Set(legacyRows.map((row) => tail(row.shopify_product_id)).filter(Boolean));
  const commerceSkus = new Set(commerceRows.map((row) => String(row.external_sku ?? "").toUpperCase()).filter(Boolean));

  const skuOwners = new Map<string, Set<string>>();
  for (const node of nodes) {
    for (const variant of node.variants) {
      const sku = String(variant.sku ?? "").trim().toUpperCase();
      if (!sku) continue;
      const owners = skuOwners.get(sku) ?? new Set<string>();
      owners.add(tail(node.id));
      skuOwners.set(sku, owners);
    }
  }

  const commerceChecks = commerceRows.map((row) => {
    const node = byProduct.get(tail(row.external_product_id));
    const variant = node?.variants.find((v) => tail(v.id) === tail(row.external_variant_id)) ?? null;
    return {
      variantId: row.variant_id,
      dbStatus: row.status,
      exists: Boolean(node),
      live: node ? live(node) : false,
      variantFound: Boolean(variant),
      skuMatches: variant ? String(variant.sku ?? "").toUpperCase() === String(row.external_sku ?? "").toUpperCase() : false,
      priceMatches: variant ? Number(variant.price) === Number(row.selling_price) : false,
      handle: node?.handle ?? null,
    };
  });

  const unlinked = nodes.filter((node) => !commerceProductIds.has(tail(node.id)) && !legacyProductIds.has(tail(node.id)));
  const unlinkedKind = (node: ShopifyCatalogNode) => {
    const skus = node.variants.map((v) => String(v.sku ?? "").trim().toUpperCase()).filter(Boolean);
    if (skus.some((sku) => commerceSkus.has(sku))) return "duplicate_of_commerce_sku";
    if (skus.some((sku) => COMMERCE_SKU.test(sku))) return "commerce_sku_not_in_db";
    if (skus.some((sku) => LEGACY_SKU.test(sku))) return "legacy_tracer_sku";
    if (node.vendor === "TRACER") return "tracer_vendor_other_sku";
    return "non_tracer_product";
  };
  const unlinkedByKind: Record<string, { total: number; live: number; samples: Array<{ handle: string; vendor: string | null; status: string; sku: string | null }> }> = {};
  for (const node of unlinked) {
    const bucket = unlinkedByKind[unlinkedKind(node)] ??= { total: 0, live: 0, samples: [] };
    bucket.total += 1;
    if (live(node)) bucket.live += 1;
    if (bucket.samples.length < 10) bucket.samples.push({ handle: node.handle, vendor: node.vendor, status: node.status, sku: node.variants[0]?.sku ?? null });
  }

  const tracerVendor = nodes.filter((node) => node.vendor === "TRACER");
  const count = (rows: typeof commerceChecks, predicate: (row: (typeof commerceChecks)[number]) => boolean) => rows.filter(predicate).length;
  const publishedRows = commerceChecks.filter((row) => row.dbStatus === "published");
  return {
    scan: { productsScanned: nodes.length, complete: scanComplete, precision: scanComplete ? "EXACT" as const : "PARTIAL" as const },
    store: {
      total: nodes.length,
      active: nodes.filter((node) => node.status === "ACTIVE").length,
      draft: nodes.filter((node) => node.status === "DRAFT").length,
      archived: nodes.filter((node) => node.status === "ARCHIVED").length,
      liveOnOnlineStore: nodes.filter(live).length,
    },
    tracerVendor: { total: tracerVendor.length, active: tracerVendor.filter((node) => node.status === "ACTIVE").length, live: tracerVendor.filter(live).length },
    commerceChannelListings: {
      rows: commerceChecks.length,
      dbPublished: publishedRows.length,
      dbPublishedAndLiveOnShopify: count(publishedRows, (row) => row.live),
      dbPublishedButNotLive: count(publishedRows, (row) => !row.live),
      missingInShopify: count(commerceChecks, (row) => !row.exists),
      variantNotFound: count(commerceChecks, (row) => row.exists && !row.variantFound),
      skuMismatch: count(commerceChecks, (row) => row.variantFound && !row.skuMatches),
      priceMismatch: count(commerceChecks, (row) => row.variantFound && !row.priceMatches),
      verified: count(publishedRows, (row) => row.live && row.skuMatches && row.priceMatches),
      liveButDbNotPublished: count(commerceChecks, (row) => row.dbStatus !== "published" && row.live),
    },
    legacyShopListings: {
      rows: legacyRows.length,
      existsInShopify: legacyRows.filter((row) => byProduct.has(tail(row.shopify_product_id))).length,
    },
    unlinkedShopifyProducts: { total: unlinked.length, live: unlinked.filter(live).length, byKind: unlinkedByKind },
    duplicateSkuGroups: [...skuOwners.values()].filter((owners) => owners.size > 1).length,
    variantProbes: (input.probeVariantIds ?? []).map((id) => {
      const check = commerceChecks.find((row) => row.variantId === id) ?? null;
      const row = commerceRows.find((item) => item.variant_id === id) ?? null;
      const owners = row?.external_sku ? [...(skuOwners.get(String(row.external_sku).toUpperCase()) ?? [])] : [];
      return { variantId: id, inDb: Boolean(row), externalSku: row?.external_sku ?? null, check, shopifyProductsWithSku: owners.length };
    }),
    commerceMismatchSamples: commerceChecks.filter((row) => row.dbStatus === "published" && !(row.live && row.skuMatches && row.priceMatches)).slice(0, 10),
  };
}
