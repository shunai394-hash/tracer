export type ShopifyColorSource = {
  productId: string;
  variantId: string;
  supplierVariantId: string;
  sku: string;
  colorLabel: string;
  imageUrl: string;
  price: number;
  inventory: number;
};

export type ShopifyColorFamilyPlan = {
  ok: boolean;
  productId: string;
  optionName: "カラー";
  variants: Array<{
    sourceProductId: string;
    sourceVariantId: string;
    supplierVariantId: string;
    sku: string;
    colorLabel: string;
    imageUrl: string;
    price: number;
    inventory: number;
  }>;
  blockers: string[];
  destructiveActions: [];
};

/**
 * Build a fail-closed migration plan for moving standalone color products into
 * one Shopify product. This is deliberately pure: it never calls Shopify and
 * never archives/deletes source products or rewrites order history.
 */
export function planShopifyColorFamily(input: {
  canonicalProductId: string;
  sources: ShopifyColorSource[];
  expectedSupplierVariantIds: string[];
}): ShopifyColorFamilyPlan {
  const blockers: string[] = [];
  const canonicalProductId = input.canonicalProductId.trim();
  const rawExpected = input.expectedSupplierVariantIds.map((id) => id.trim()).filter(Boolean);
  const expected = [...new Set(rawExpected)];
  if (!canonicalProductId) blockers.push("canonical_product_id_missing");
  if (expected.length < 2) blockers.push("expected_variants_incomplete");
  if (rawExpected.length !== expected.length) blockers.push("expected_supplier_variant_id_duplicate");

  const bySupplierId = new Map<string, ShopifyColorSource[]>();
  const bySku = new Map<string, string[]>();
  const byVariantId = new Map<string, string[]>();
  const byColorLabel = new Map<string, string[]>();

  for (const source of input.sources) {
    const id = source.supplierVariantId.trim();
    const sku = source.sku.trim();
    const variantId = source.variantId.trim();
    const colorLabel = source.colorLabel.trim();

    if (!id) {
      blockers.push("supplier_variant_id_missing");
      continue;
    }
    bySupplierId.set(id, [...(bySupplierId.get(id) ?? []), source]);
    if (sku) bySku.set(sku, [...(bySku.get(sku) ?? []), id]);
    if (variantId) byVariantId.set(variantId, [...(byVariantId.get(variantId) ?? []), id]);
    if (colorLabel) byColorLabel.set(colorLabel.toLocaleLowerCase("ja-JP"), [...(byColorLabel.get(colorLabel.toLocaleLowerCase("ja-JP")) ?? []), id]);

    if (!source.productId.trim() || !variantId) blockers.push("shopify_source_identity_missing:" + id);
    if (!sku) blockers.push("sku_missing:" + id);
    if (!colorLabel || colorLabel === "標準") blockers.push("color_label_missing:" + id);
    if (!/^https?:\\/\\//i.test(source.imageUrl.trim())) blockers.push("variant_image_missing:" + id);
    if (!Number.isFinite(source.price) || source.price <= 0) blockers.push("price_invalid:" + id);
    if (!Number.isSafeInteger(source.inventory) || source.inventory < 0) blockers.push("inventory_invalid:" + id);
  }

  for (const [sku, ids] of bySku) {
    if (ids.length > 1) blockers.push("sku_ambiguous:" + sku);
  }
  for (const [variantId, ids] of byVariantId) {
    if (ids.length > 1) blockers.push("shopify_variant_id_ambiguous:" + variantId);
  }
  for (const [label, ids] of byColorLabel) {
    if (ids.length > 1) blockers.push("color_label_ambiguous:" + label);
  }

  for (const id of expected) {
    const matches = bySupplierId.get(id) ?? [];
    if (matches.length === 0) blockers.push("expected_supplier_variant_missing:" + id);
    if (matches.length > 1) blockers.push("supplier_variant_ambiguous:" + id);
  }
  for (const id of bySupplierId.keys()) {
    if (!expected.includes(id)) blockers.push("unexpected_supplier_variant:" + id);
  }
  if (input.sources.length !== expected.length) blockers.push("source_variant_count_mismatch");

  const variants = expected.flatMap((id) => {
    const source = bySupplierId.get(id)?.[0];
    if (!source) return [];
    return [{
      sourceProductId: source.productId,
      sourceVariantId: source.variantId,
      supplierVariantId: id,
      sku: source.sku.trim(),
      colorLabel: source.colorLabel.trim(),
      imageUrl: source.imageUrl.trim(),
      price: source.price,
      inventory: source.inventory,
    }];
  });

  return {
    ok: blockers.length === 0 && variants.length === expected.length,
    productId: canonicalProductId,
    optionName: "カラー",
    variants,
    blockers: [...new Set(blockers)],
    destructiveActions: [],
  };
}
