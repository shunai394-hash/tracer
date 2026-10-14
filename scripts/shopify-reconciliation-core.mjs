function normalizeId(value) {
  return String(value ?? "").replace(/^gid:\/\/shopify\/(?:Product|ProductVariant)\//, "");
}

function finiteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function expectedShopifySku(row) {
  const source = (typeof row.supplier_variant_id === "string" ? row.supplier_variant_id.trim() : "")
    || (typeof row.supplier_product_id === "string" ? row.supplier_product_id.trim() : "")
    || String(row.id ?? "").trim();
  return source ? `TRC-${source}`.slice(0, 100) : "";
}

export function indexShopifyCatalog(products) {
  const productsById = new Map();
  const variantsById = new Map();

  for (const product of products ?? []) {
    const productId = normalizeId(product.legacyResourceId ?? product.id);
    if (!productId) continue;
    const indexedProduct = {
      productId,
      title: product.title ?? null,
      status: product.status ?? null,
      variants: product.variants?.nodes ?? [],
    };
    productsById.set(productId, indexedProduct);

    for (const variant of indexedProduct.variants) {
      const variantId = normalizeId(variant.legacyResourceId ?? variant.id);
      if (!variantId) continue;
      variantsById.set(variantId, {
        variantId,
        productId,
        productTitle: indexedProduct.title,
        productStatus: indexedProduct.status,
        sku: variant.sku ?? null,
        price: variant.price ?? null,
        inventoryQuantity: variant.inventoryQuantity ?? null,
      });
    }
  }

  return { productsById, variantsById };
}

export function reconcileShopifyListing(row, catalogIndex) {
  const productId = normalizeId(row.shopify_product_id);
  const variantId = normalizeId(row.shopify_variant_id);
  const product = productId ? catalogIndex.productsById.get(productId) ?? null : null;
  const variant = variantId ? catalogIndex.variantsById.get(variantId) ?? null : null;
  const sku = expectedShopifySku(row);
  const expectedPrice = finiteNumber(row.selling_price);
  const livePrice = variant ? finiteNumber(variant.price) : null;
  const expectedInventory = finiteNumber(row.inventory);
  const liveInventory = variant ? finiteNumber(variant.inventoryQuantity) : null;
  const mismatches = [];

  if (!row.shopify_product_id) mismatches.push("db_shopify_product_id_missing");
  else if (!product) mismatches.push("shopify_product_missing");
  if (!row.shopify_variant_id) mismatches.push("db_shopify_variant_id_missing");
  else if (!variant) mismatches.push("shopify_variant_missing");
  if (product && row.published === true && product.status !== "ACTIVE") {
    mismatches.push("db_published_but_shopify_product_not_active");
  }
  if (product && row.published !== true && product.status === "ACTIVE") {
    // Shopify's ACTIVE status is not identical to Online Store channel publication.
    // This is a status disagreement signal, not definitive proof that buyers see it.
    mismatches.push("db_unpublished_but_shopify_product_active_status");
  }
  if (variant && (!sku || String(variant.sku ?? "").trim() !== sku)) mismatches.push("sku_mismatch");
  if (variant && (expectedPrice === null || livePrice === null || Math.abs(expectedPrice - livePrice) > 0.01)) {
    mismatches.push(expectedPrice === null ? "db_price_unknown" : "price_mismatch");
  }
  if (variant && (expectedInventory === null || liveInventory === null || expectedInventory !== liveInventory)) {
    mismatches.push(expectedInventory === null ? "db_inventory_unknown" : "inventory_mismatch");
  }

  return {
    listingId: String(row.id ?? ""),
    productId: row.shopify_product_id ?? null,
    variantId: row.shopify_variant_id ?? null,
    productFound: product !== null,
    variantFound: variant !== null,
    productStatus: product?.status ?? null,
    dbPublished: row.published === true,
    expectedSku: sku || null,
    liveSku: variant?.sku ?? null,
    skuMatches: variant ? String(variant.sku ?? "").trim() === sku : false,
    expectedPrice,
    livePrice,
    priceMatches: expectedPrice !== null && livePrice !== null && Math.abs(expectedPrice - livePrice) <= 0.01,
    expectedInventory,
    liveInventory,
    inventoryMatches: expectedInventory !== null && liveInventory !== null && expectedInventory === liveInventory,
    mismatches,
  };
}

export function summarizeShopifyListingReconciliation(comparisons) {
  const count = (reason) => comparisons.filter((row) => row.mismatches.includes(reason)).length;
  const withMismatch = comparisons.filter((row) => row.mismatches.length > 0);
  return {
    comparedListings: comparisons.length,
    productMissing: count("shopify_product_missing"),
    variantMissing: count("shopify_variant_missing"),
    skuMismatch: count("sku_mismatch"),
    priceMismatch: count("price_mismatch"),
    inventoryMismatch: count("inventory_mismatch"),
    dbPriceUnknown: count("db_price_unknown"),
    dbInventoryUnknown: count("db_inventory_unknown"),
    statusDisagreement: count("db_published_but_shopify_product_not_active") + count("db_unpublished_but_shopify_product_active_status"),
    mismatchListingCount: withMismatch.length,
    mismatchSamples: withMismatch.slice(0, 200),
    note: "Shopify product ACTIVE status is not itself proof of publication to the Online Store channel; status disagreement is a review signal.",
  };
}
