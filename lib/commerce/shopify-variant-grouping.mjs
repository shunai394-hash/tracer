/**
 * Pure, read-only planner for grouping canonical commerce variants into Shopify
 * parent products. This module never calls a channel API or mutates stored data.
 */

export function planShopifyVariantGroups(rows) {
  if (!Array.isArray(rows)) throw new TypeError("rows_must_be_array");

  const groups = new Map();
  const globalVariantIds = new Set();
  const globalSupplierVariantIds = new Set();
  const productIdsBySourceKey = new Map();

  for (const row of rows) {
    const productId = String(row?.product_id ?? "").trim();
    const sourceKey = String(row?.source_key ?? "").trim();
    const variantId = String(row?.variant_id ?? "").trim();
    const supplierCode = String(row?.supplier_code ?? "").trim().toLowerCase();
    const supplierProductId = String(row?.supplier_product_id ?? "").trim();
    const supplierVariantId = String(row?.supplier_variant_id ?? "").trim();
    const sku = String(row?.sku ?? "").trim();
    const price = Number(row?.selling_price);
    const inventory = Number(row?.inventory);

    const identityErrors = [];
    if (!productId) identityErrors.push("product_id_missing");
    if (!sourceKey) identityErrors.push("source_key_missing");
    if (!variantId) identityErrors.push("variant_id_missing");
    if (!supplierCode) identityErrors.push("supplier_code_missing");
    if (!supplierProductId) identityErrors.push("supplier_product_id_missing");
    if (!supplierVariantId) identityErrors.push("supplier_variant_id_missing");
    if (!sku) identityErrors.push("sku_missing");
    if (!Number.isFinite(price) || price <= 0) identityErrors.push("selling_price_invalid");
    if (!Number.isFinite(inventory) || inventory < 0) identityErrors.push("inventory_invalid");

    if (variantId && globalVariantIds.has(variantId)) identityErrors.push("variant_id_duplicate_in_input");
    if (variantId) globalVariantIds.add(variantId);
    const supplierIdentity = supplierCode && supplierProductId && supplierVariantId
      ? `${supplierCode}:${supplierProductId}:${supplierVariantId}`
      : "";
    if (supplierIdentity && globalSupplierVariantIds.has(supplierIdentity)) identityErrors.push("supplier_variant_identity_duplicate_in_input");
    if (supplierIdentity) globalSupplierVariantIds.add(supplierIdentity);

    if (sourceKey && productId) {
      const owners = productIdsBySourceKey.get(sourceKey) ?? new Set();
      owners.add(productId);
      productIdsBySourceKey.set(sourceKey, owners);
    }

    const key = productId && sourceKey ? `${productId}::${sourceKey}` : `invalid-row:${groups.size}`;
    const group = groups.get(key) ?? {
      productId,
      sourceKey,
      variants: [],
      blockingReasons: [],
    };
    group.variants.push({
      variantId,
      supplierCode,
      supplierProductId,
      supplierVariantId,
      sku,
      sellingPrice: Number.isFinite(price) ? price : null,
      inventory: Number.isFinite(inventory) ? inventory : null,
      currentShopifyProductId: String(row?.shopify_product_id ?? "").trim() || null,
      currentShopifyVariantId: String(row?.shopify_variant_id ?? "").trim() || null,
      currentBaseItemId: String(row?.base_item_id ?? "").trim() || null,
      identityErrors,
    });
    group.blockingReasons.push(...identityErrors.map((reason) => `${variantId || "unknown"}:${reason}`));
    groups.set(key, group);
  }

  // A canonical supplier parent key must resolve to exactly one internal product.
  // Otherwise grouping by (product_id, source_key) would silently split the same
  // source parent into separate groups and could create additional Shopify pages.
  for (const group of groups.values()) {
    const owners = productIdsBySourceKey.get(group.sourceKey);
    if (owners && owners.size > 1) {
      group.blockingReasons.push("source_key_maps_to_multiple_internal_product_ids");
    }
  }

  return [...groups.values()]
    .map((group) => {
      const skuOwners = new Map();
      const supplierVariantOwners = new Map();
      for (const variant of group.variants) {
        if (variant.sku) skuOwners.set(variant.sku, (skuOwners.get(variant.sku) ?? 0) + 1);
        const key = variant.supplierCode && variant.supplierProductId && variant.supplierVariantId
          ? `${variant.supplierCode}:${variant.supplierProductId}:${variant.supplierVariantId}`
          : "";
        if (key) supplierVariantOwners.set(key, (supplierVariantOwners.get(key) ?? 0) + 1);
      }
      for (const [sku, count] of skuOwners) {
        if (count > 1) group.blockingReasons.push(`sku_duplicated_in_group:${sku}`);
      }
      for (const [identity, count] of supplierVariantOwners) {
        if (count > 1) group.blockingReasons.push(`supplier_variant_duplicated_in_group:${identity}`);
      }

      const existingShopifyProductIds = [...new Set(group.variants.map((v) => v.currentShopifyProductId).filter(Boolean))];
      const hasPartialShopifyMapping = group.variants.some((v) => Boolean(v.currentShopifyProductId) !== Boolean(v.currentShopifyVariantId));
      if (hasPartialShopifyMapping) group.blockingReasons.push("partial_shopify_mapping");
      if (existingShopifyProductIds.length > 1) group.blockingReasons.push("multiple_existing_shopify_products_need_migration_map");

      return {
        productId: group.productId || null,
        sourceKey: group.sourceKey || null,
        variantCount: group.variants.length,
        proposedGroupKey: group.sourceKey || null,
        existingShopifyProductIds,
        canProceedToDryRunReview: group.blockingReasons.length === 0,
        blockingReasons: [...new Set(group.blockingReasons)],
        variants: group.variants,
      };
    })
    .sort((a, b) => String(a.sourceKey ?? "").localeCompare(String(b.sourceKey ?? "")));
}
