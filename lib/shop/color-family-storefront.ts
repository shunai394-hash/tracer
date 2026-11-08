export type ColorFamilyMember = {
  id: string;
  slug: string;
  title: string;
  productId: string;
  supplierName: string | null;
  supplierProductId: string | null;
  supplierVariantId: string | null;
  sku?: string | null;
  imageUrl: string | null;
  /** True only when the image URL came from the exact supplier variant ID response. */
  variantImageIdentityVerified?: boolean;
  sellingPrice: number | null;
  currency: string | null;
  inventory: number;
  shopifyVariantId: string | null;
  shopifyHandle: string | null;
  manualInventory?: boolean;
};

export type ColorFamilyChoice = {
  id: string;
  slug: string;
  title: string;
  label: string;
  imageUrl: string | null;
  sellingPrice: number | null;
  currency: string | null;
  inventory: number;
  sku: string | null;
  supplierProductId: string | null;
  supplierVariantId: string | null;
  shopifyVariantId: string | null;
  shopifyHandle: string | null;
};

export type ColorFamilyView<T> = T & {
  variants: ColorFamilyChoice[];
  colorSaleBlocked: boolean;
  colorSaleBlockers: string[];
};

const COLOR_SUFFIX = /\s*[（(]([^()（）]+)[）)]\s*$/u;

export function colorLabelFromTitle(title: string): string | null {
  const label = title.normalize("NFKC").trim().match(COLOR_SUFFIX)?.[1]?.trim() ?? "";
  if (!label || label === "標準") return null;
  return label;
}

export function parentTitleFromColorTitle(title: string): string {
  return title.normalize("NFKC").replace(COLOR_SUFFIX, "").trim();
}

function httpsImage(value: string | null): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function supplierIdentity(member: ColorFamilyMember): { supplier: string; productId: string; supplierProductId: string } | null {
  const supplier = member.supplierName?.trim().toLowerCase() ?? "";
  const productId = member.productId.trim();
  const supplierProductId = member.supplierProductId?.trim() ?? "";
  const supplierVariantId = member.supplierVariantId?.trim() ?? "";
  if (member.manualInventory || !supplier || !productId || !supplierProductId || !supplierVariantId) return null;
  return { supplier, productId, supplierProductId };
}

function choiceFrom(member: ColorFamilyMember, label: string, imageUrl: string | null): ColorFamilyChoice {
  return {
    id: member.id,
    slug: member.slug,
    title: member.title,
    label,
    imageUrl,
    sellingPrice: member.sellingPrice,
    currency: member.currency,
    inventory: member.inventory,
    sku: member.sku?.trim() || null,
    supplierProductId: member.supplierProductId?.trim() || null,
    supplierVariantId: member.supplierVariantId?.trim() || null,
    shopifyVariantId: member.shopifyVariantId,
    shopifyHandle: member.shopifyHandle,
  };
}

function single<T extends ColorFamilyMember>(member: T, blockers: string[] = []): ColorFamilyView<T> {
  return {
    ...member,
    variants: [],
    colorSaleBlocked: blockers.length > 0,
    colorSaleBlockers: blockers,
  };
}

function buildFamily<T extends ColorFamilyMember>(members: T[], requireSku: boolean): ColorFamilyView<T> {
  const blockers: string[] = [];
  const labels = new Map<string, string>();
  const skus = new Map<string, string>();
  const images = new Map<string, string>();
  const supplierVariants = new Map<string, string>();
  const shopifyVariants = new Map<string, string>();
  const choices: ColorFamilyChoice[] = [];

  for (const member of members) {
    const label = colorLabelFromTitle(member.title);
    const imageUrl = httpsImage(member.imageUrl);
    const sku = member.sku?.trim() ?? "";
    const supplierVariantId = member.supplierVariantId?.trim() ?? "";
    const shopifyVariantId = member.shopifyVariantId?.trim() ?? "";
    const labelKey = label?.toLocaleLowerCase("ja-JP") ?? "";

    if (!label) blockers.push("color_label_missing:" + member.id);
    else if (labels.has(labelKey)) blockers.push("color_label_ambiguous:" + labelKey);
    else labels.set(labelKey, member.id);

    if (!imageUrl) blockers.push("variant_image_missing:" + member.id);
    else if (images.has(imageUrl)) blockers.push("variant_image_ambiguous:" + member.id);
    else images.set(imageUrl, member.id);
    if (member.variantImageIdentityVerified !== true) blockers.push("variant_image_identity_unverified:" + member.id);

    if (!sku) {
      if (requireSku) blockers.push("sku_missing:" + member.id);
    } else if (skus.has(sku)) blockers.push("sku_ambiguous:" + sku);
    else skus.set(sku, member.id);

    if (!supplierVariantId) blockers.push("supplier_variant_id_missing:" + member.id);
    else if (supplierVariants.has(supplierVariantId)) blockers.push("supplier_variant_ambiguous:" + supplierVariantId);
    else supplierVariants.set(supplierVariantId, member.id);

    if (shopifyVariantId) {
      if (shopifyVariants.has(shopifyVariantId)) blockers.push("shopify_variant_ambiguous:" + shopifyVariantId);
      else shopifyVariants.set(shopifyVariantId, member.id);
    }

    if (!Number.isFinite(member.sellingPrice) || (member.sellingPrice ?? 0) <= 0 || member.currency?.trim().toUpperCase() !== "JPY") {
      blockers.push("price_invalid:" + member.id);
    }
    if (!Number.isSafeInteger(member.inventory) || member.inventory < 0) blockers.push("inventory_invalid:" + member.id);

    choices.push(choiceFrom(member, label ?? "", imageUrl));
  }

  const sorted = [...choices].sort((a, b) => a.label.localeCompare(b.label, "ja"));
  const representative = members.find((member) => member.id === sorted[0]?.id) ?? members[0];
  const parents = new Set(members.map((member) => parentTitleFromColorTitle(member.title)).filter(Boolean));
  const title = parents.size === 1 ? [...parents][0] : representative.title;
  return {
    ...representative,
    title,
    imageUrl: sorted.find((choice) => choice.imageUrl)?.imageUrl ?? representative.imageUrl,
    variants: sorted,
    colorSaleBlocked: blockers.length > 0,
    colorSaleBlockers: [...new Set(blockers)],
  };
}

/**
 * Collapse listings that share one canonical product and one exact supplier
 * product id. Title similarity never creates a family. A family with image-only
 * evidence gaps stays as separate existing listings until distinct exact-variant image
 * identities are verified; other identity, SKU, price, or stock failures fail closed.
 */
export function groupExactColorFamilies<T extends ColorFamilyMember>(
  members: T[],
  options: { requireSku?: boolean } = {},
): { catalog: Array<ColorFamilyView<T>> } {
  const requireSku = options.requireSku !== false;
  const singles: Array<ColorFamilyView<T>> = [];
  const byFamily = new Map<string, T[]>();
  const productIdsBySupplier = new Map<string, Set<string>>();

  for (const member of members) {
    const identity = supplierIdentity(member);
    if (!identity) {
      singles.push(single(member));
      continue;
    }
    const supplierKey = JSON.stringify([identity.supplier, identity.supplierProductId]);
    const productIds = productIdsBySupplier.get(supplierKey) ?? new Set<string>();
    productIds.add(identity.productId);
    productIdsBySupplier.set(supplierKey, productIds);
    const familyKey = JSON.stringify([identity.supplier, identity.productId, identity.supplierProductId]);
    byFamily.set(familyKey, [...(byFamily.get(familyKey) ?? []), member]);
  }

  const catalog = [...singles];
  for (const [familyKey, group] of byFamily) {
    const parsed = JSON.parse(familyKey) as [string, string, string];
    const supplierKey = JSON.stringify([parsed[0], parsed[2]]);
    const conflicted = (productIdsBySupplier.get(supplierKey)?.size ?? 0) > 1;
    if (conflicted) {
      for (const member of group) {
        catalog.push(single(member, ["supplier_product_id_conflict:" + member.supplierProductId]));
      }
      continue;
    }
    if (group.length === 1) {
      catalog.push(single(group[0]));
      continue;
    }
    const family = buildFamily(group, requireSku);
    // A multi-color family is one sellable page only when every identity,
    // SKU, price, stock, label, and exact-variant image identity check passes. Do not
    // fall back to separately purchasable color pages when any check fails.
    if (family.colorSaleBlocked) {
      for (const member of group) {
        catalog.push(single(member, ["color_family_unverified:" + family.colorSaleBlockers.join(",")]));
      }
    } else {
      catalog.push(family);
    }
  }

  return { catalog };
}
