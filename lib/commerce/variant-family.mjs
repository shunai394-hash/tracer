/**
 * Groups color and size variants that already share one supplier product id.
 * A similar title is never enough to merge two supplier products.
 */

export const TARGET_MARGIN_RATE = 0.5;
export const MAX_VARIATIONS_PER_PRODUCT = 50;

const COLOR_RULES = [
  [/蛍光グリーン|fluorescent green/, "蛍光グリーン"],
  [/ローズレッド|rose red/, "ローズレッド"],
  [/ワインレッド|red wine/, "ワインレッド"],
  [/ネイビー|navy/, "ネイビー"],
  [/ブラック|黒|black/, "ブラック"],
  [/ホワイト|白|white/, "ホワイト"],
  [/グレー|灰|gray|grey/, "グレー"],
  [/シルバー|銀|silver/, "シルバー"],
  [/ゴールド|金|gold/, "ゴールド"],
  [/ベージュ|beige/, "ベージュ"],
  [/カーキ|khaki/, "カーキ"],
  [/ブラウン|茶|brown/, "ブラウン"],
  [/アプリコット|apricot/, "アプリコット"],
  [/クリーム|cream/, "クリーム"],
  [/モカ|mocha/, "モカ"],
  [/ピンク|pink/, "ピンク"],
  [/パープル|紫|purple/, "パープル"],
  [/オレンジ|orange/, "オレンジ"],
  [/イエロー|黄|yellow/, "イエロー"],
  [/グリーン|緑|green/, "グリーン"],
  [/ブルー|青|blue/, "ブルー"],
  [/レッド|赤|red/, "レッド"],
  [/シアン|cyan/, "シアン"],
];

const SIZE_TOKENS = new Map([
  ["xxxs", "XXXS"], ["xxs", "XXS"], ["xs", "XS"], ["s", "S"], ["m", "M"], ["l", "L"],
  ["xl", "XL"], ["xxl", "XXL"], ["xxxl", "XXXL"], ["2xl", "2XL"], ["3xl", "3XL"], ["4xl", "4XL"],
  ["free", "フリー"], ["freesize", "フリー"], ["フリー", "フリー"], ["フリーサイズ", "フリー"],
]);

export function normalizeVariationText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function tracerChannelSku(variantId) {
  return "TRC-" + String(variantId ?? "").replace(/-/g, "").slice(0, 24).toUpperCase();
}

export function parentProductHandle(sourceKey) {
  const slug = normalizeVariationText(sourceKey).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return slug || "tracer-item";
}

export function channelVariationName(label) {
  return normalizeVariationText(label).replace(/[\u{10000}-\u{10FFFF}]/gu, "").slice(0, 255);
}

export function variationSourceLabel(member) {
  const title = normalizeVariationText(member?.title);
  const paren = title.match(/[(（]([^)）]{1,80})[)）]\s*$/u);
  if (paren) return normalizeVariationText(paren[1]);
  const supplierName = normalizeVariationText(member?.supplierVariantName);
  if (supplierName) return supplierName;
  return title || "標準";
}

export function stripVariantSuffix(title) {
  return normalizeVariationText(title).replace(/[(（][^)）]*[)）]\s*$/u, "").trim();
}

function matchColor(value) {
  const source = normalizeVariationText(value).toLowerCase();
  if (!source) return null;
  for (const [pattern, label] of COLOR_RULES) {
    if (pattern.test(source)) return label;
  }
  return null;
}

function matchSizeToken(value) {
  const token = normalizeVariationText(value).toLowerCase().replace(/\s+/g, "");
  if (SIZE_TOKENS.has(token)) return SIZE_TOKENS.get(token);
  const measured = token.match(/^(\d+(?:\.\d+)?)(cm|mm|号)$/u);
  if (measured) return measured[1] + measured[2];
  return null;
}

export function parseVariationOptions(rawLabel) {
  const label = channelVariationName(rawLabel);
  const parts = label.split(/\s*[\/|,・]\s*|\s+-\s+/u).map((part) => normalizeVariationText(part)).filter(Boolean);
  let color = null;
  let size = null;
  for (const part of parts.length > 0 ? parts : [label]) {
    const parsedColor = matchColor(part);
    const parsedSize = matchSizeToken(part);
    if (parsedColor && !color) color = parsedColor;
    else if (parsedSize && !size) size = parsedSize;
  }
  return { label, color, size };
}

function optionKey(options) {
  return Object.keys(options).sort().map((key) => key + "=" + options[key]).join("|");
}

function chooseAxes(parsed) {
  const labels = parsed.map((item) => item.label);
  if (labels.some((label) => !label) || new Set(labels).size !== labels.length) {
    return { ok: false, reason: "variation_label_collision" };
  }
  const allHaveColor = parsed.every((item) => item.color);
  const allHaveSize = parsed.every((item) => item.size);
  const colorKeys = parsed.map((item) => item.color);
  const sizeKeys = parsed.map((item) => item.size);
  const pairKeys = parsed.map((item) => item.color + "\0" + item.size);
  if (allHaveColor && allHaveSize && new Set(pairKeys).size === parsed.length) {
    return { ok: true, axes: ["色", "サイズ"], options: parsed.map((item) => ({ "色": item.color, "サイズ": item.size })) };
  }
  if (allHaveColor && !parsed.some((item) => item.size) && new Set(colorKeys).size === parsed.length) {
    return { ok: true, axes: ["色"], options: parsed.map((item) => ({ "色": item.color })) };
  }
  if (allHaveSize && !parsed.some((item) => item.color) && new Set(sizeKeys).size === parsed.length) {
    return { ok: true, axes: ["サイズ"], options: parsed.map((item) => ({ "サイズ": item.size })) };
  }
  const optionList = parsed.map((item) => ({ "種類": item.label }));
  if (new Set(optionList.map(optionKey)).size !== optionList.length) return { ok: false, reason: "variation_label_collision" };
  return { ok: true, axes: ["種類"], options: optionList };
}

function supplierIds(members) {
  return [...new Set(members.map((member) => normalizeVariationText(member.supplierProductId)).filter(Boolean))];
}

export function planVariantFamily(input) {
  const productId = normalizeVariationText(input?.productId);
  const members = Array.isArray(input?.members) ? input.members : [];
  if (!productId || members.length < 2) return { ok: false, productId, reason: "variant_family_too_small" };
  if (members.length > MAX_VARIATIONS_PER_PRODUCT) return { ok: false, productId, reason: "too_many_variations" };
  const ids = supplierIds(members);
  if (ids.length !== 1) return { ok: false, productId, reason: ids.length === 0 ? "supplier_product_id_missing" : "supplier_product_id_conflict" };
  const supplierProductId = ids[0];
  if (members.some((member) => member.productId && normalizeVariationText(member.productId) !== productId)) {
    return { ok: false, productId, reason: "parent_product_mismatch" };
  }

  const excluded = [];
  const channelMembers = [];
  for (const member of members) {
    const variantId = normalizeVariationText(member.variantId);
    const supplierVariantId = normalizeVariationText(member.supplierVariantId);
    const missing = Array.isArray(member.missingEvidence) ? member.missingEvidence.filter(Boolean) : [];
    const margin = Number(member.marginRate);
    const price = Number(member.sellingPrice);
    const inventory = Number(member.inventory);
    const identityReady = Boolean(variantId && supplierVariantId && normalizeVariationText(member.supplierProductId) === supplierProductId);
    if (!identityReady) {
      excluded.push({ variantId, reason: "supplier_identity_incomplete" });
      continue;
    }
    const marginReady = Number.isFinite(margin) && margin + Number.EPSILON >= TARGET_MARGIN_RATE && Number.isFinite(price) && price > 0;
    const stockReady = Number.isInteger(inventory) && inventory > 0;
    // Evidence age is recorded for diagnostics; known positive stock/cost/shipping/profit evidence governs sale eligibility.
    const sellable = missing.length === 0 && marginReady && stockReady;
    const withheldReason = sellable ? null : missing.length > 0 ? missing.join(",") : !marginReady ? "margin_below_target" : "stock_unavailable";
    channelMembers.push({
      variantId,
      supplierProductId,
      supplierVariantId,
      sku: normalizeVariationText(member.sku) || tracerChannelSku(variantId),
      existingExternalProductId: normalizeVariationText(member.existingExternalProductId) || null,
      existingExternalVariantId: normalizeVariationText(member.existingExternalVariantId) || null,
      title: normalizeVariationText(member.title),
      supplierVariantName: member.supplierVariantName ?? null,
      sellingPrice: Math.round(price),
      inventory: sellable ? inventory : 0,
      sellable,
      withheldReason,
      missingEvidence: missing,
    });
  }
  if (channelMembers.length < 2 && excluded.length === members.length) {
    return { ok: false, productId, reason: "no_channel_safe_variations" };
  }
  if (channelMembers.length < 2) {
    return { ok: false, productId, reason: "variant_family_not_ready", excluded };
  }
  const parsed = channelMembers.map((member) => parseVariationOptions(variationSourceLabel(member)));
  const axes = chooseAxes(parsed);
  if (!axes.ok) return { ok: false, productId, reason: axes.reason, excluded };
  const seen = new Set();
  for (const options of axes.options) {
    const key = optionKey(options);
    if (seen.has(key)) return { ok: false, productId, reason: "variation_label_collision" };
    seen.add(key);
  }
  const sellablePrices = channelMembers.filter((member) => member.sellable).map((member) => member.sellingPrice);
  const basePrice = sellablePrices.length > 0 ? Math.max(...sellablePrices) : null;
  const basePricePolicy = sellablePrices.length === 0
    ? "none_sellable"
    : new Set(sellablePrices).size === 1 ? "shared_price" : "highest_variant_price";
  const productTitle = stripVariantSuffix(input.productTitle) || stripVariantSuffix(channelMembers[0].title);
  const variations = channelMembers.map((member, index) => ({
    ...member,
    label: parsed[index].label,
    options: axes.options[index],
    imageAlt: [productTitle, parsed[index].label].filter(Boolean).join(" "),
  }));
  return {
    ok: true,
    productId,
    sourceKey: normalizeVariationText(input.sourceKey),
    supplierProductId,
    handle: parentProductHandle(input.sourceKey || supplierProductId),
    productTitle,
    description: String(input.description ?? ""),
    imageUrl: input.imageUrl ?? null,
    axes: axes.axes,
    basePrice,
    basePricePolicy,
    visible: variations.some((variation) => variation.sellable),
    variations,
    excluded,
  };
}

export function chooseCanonicalExternalProductId(variations) {
  const counts = new Map();
  for (const variation of variations ?? []) {
    const id = normalizeVariationText(variation.existingExternalProductId);
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked[0]?.[0] ?? null;
}

export function sharedParentTitle(titles) {
  const stripped = (titles ?? []).map(stripVariantSuffix).filter(Boolean);
  if (stripped.length === 0) return "";
  const shortest = [...stripped].sort((a, b) => a.length - b.length)[0];
  return stripped.every((title) => title === shortest || title.startsWith(shortest)) ? shortest : stripped[0];
}

export function findRefusedTitleGroups(products) {
  const groups = new Map();
  for (const product of products ?? []) {
    const title = stripVariantSuffix(product.title);
    const supplierProductId = normalizeVariationText(product.supplierProductId);
    if (!title || !supplierProductId) continue;
    const rows = groups.get(title) ?? [];
    rows.push({ productId: product.productId, supplierProductId, variantCount: Number(product.variantCount) || 1 });
    groups.set(title, rows);
  }
  const refused = [];
  for (const [title, rows] of groups) {
    const supplierIds = [...new Set(rows.map((row) => row.supplierProductId))];
    if (supplierIds.length < 2) continue;
    refused.push({ title, reason: "supplier_product_id_conflict", products: rows });
  }
  return refused.sort((a, b) => a.title.localeCompare(b.title, "ja"));
}

function publishedListings(listings) {
  return (listings ?? []).filter((listing) => listing?.status === "published");
}

export function resolveBaseOrderVariant(item, listings) {
  const itemId = normalizeVariationText(item?.itemId);
  const matches = publishedListings(listings).filter((listing) => normalizeVariationText(listing.externalProductId) === itemId);
  if (!itemId || matches.length === 0) return { ok: false, reason: "base_item_not_linked" };
  const variationId = normalizeVariationText(item?.variationId);
  const variationIdentifier = normalizeVariationText(item?.variationIdentifier).toUpperCase();
  const byVariation = variationId ? matches.filter((listing) => normalizeVariationText(listing.externalVariantId) === variationId) : [];
  const byIdentifier = variationIdentifier
    ? matches.filter((listing) => normalizeVariationText(listing.externalSku).toUpperCase() === variationIdentifier)
    : [];
  if (byVariation.length === 1 && byIdentifier.length === 1 && byVariation[0].variantId !== byIdentifier[0].variantId) {
    return { ok: false, reason: "base_variation_identifier_conflict" };
  }
  if (byVariation.length > 1) return { ok: false, reason: "base_variation_ambiguous" };
  if (byVariation.length === 1) return { ok: true, variantId: byVariation[0].variantId, supplierVariantId: byVariation[0].supplierVariantId ?? null };
  if (byIdentifier.length > 1) return { ok: false, reason: "base_variation_identifier_ambiguous" };
  if (byIdentifier.length === 1) return { ok: true, variantId: byIdentifier[0].variantId, supplierVariantId: byIdentifier[0].supplierVariantId ?? null };
  if (matches.length === 1 && !variationId && !variationIdentifier) {
    return { ok: true, variantId: matches[0].variantId, supplierVariantId: matches[0].supplierVariantId ?? null };
  }
  if (matches.length > 1) return { ok: false, reason: "base_variation_not_linked" };
  return { ok: true, variantId: matches[0].variantId, supplierVariantId: matches[0].supplierVariantId ?? null };
}

export function resolveShopifyOrderVariant(line, listings) {
  const gid = normalizeVariationText(line?.shopifyVariantGid);
  const sku = normalizeVariationText(line?.sku).toUpperCase();
  const published = publishedListings(listings);
  const byGid = gid ? published.filter((listing) => normalizeVariationText(listing.externalVariantId) === gid) : [];
  const bySku = sku ? published.filter((listing) => normalizeVariationText(listing.externalSku).toUpperCase() === sku) : [];
  if (byGid.length > 1) return { ok: false, reason: "shopify_variant_ambiguous" };
  if (bySku.length > 1) return { ok: false, reason: "shopify_sku_ambiguous" };
  if (byGid.length === 1 && bySku.length === 1 && byGid[0].variantId !== bySku[0].variantId) {
    return { ok: false, reason: "shopify_variant_sku_conflict" };
  }
  if (byGid.length === 1) return { ok: true, variantId: byGid[0].variantId, supplierVariantId: byGid[0].supplierVariantId ?? null };
  if (bySku.length === 1) return { ok: true, variantId: bySku[0].variantId, supplierVariantId: bySku[0].supplierVariantId ?? null };
  return { ok: false, reason: "shopify_variant_not_linked" };
}

export function newfindFamilyPayload(listings) {
  const rows = Array.isArray(listings) ? listings : [];
  const title = sharedParentTitle(rows.map((row) => row.title));
  const variations = rows.map((row) => {
    const parsed = parseVariationOptions(variationSourceLabel({ title: row.title, supplierVariantName: row.supplierVariantName }));
    return {
      tracer_listing_id: row.id,
      label: parsed.label,
      color: parsed.color,
      size: parsed.size,
      sku: row.sku || null,
      supplier_variant_id: row.supplierVariantId || null,
      price: Number(row.sellingPrice) || 0,
      inventory: Number(row.inventory) || 0,
      image_alt: [title, parsed.label].filter(Boolean).join(" "),
      url: row.url || null,
    };
  });
  return {
    product_name: title || rows[0]?.title || "",
    tracer_product_id: rows[0]?.productId || null,
    variations,
  };
}
