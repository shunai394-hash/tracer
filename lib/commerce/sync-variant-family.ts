import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { asRelationRows } from "@/lib/commerce/relation-rows";
import { missingSaleEvidence } from "@/lib/commerce/sale-evidence";
import { isCanonicalCjNativeId } from "@/lib/commerce/core";
import {
  chooseCanonicalExternalProductId,
  planVariantFamily,
  tracerChannelSku,
} from "@/lib/commerce/variant-family.mjs";

type FamilyVariation = {
  variantId: string;
  supplierProductId: string;
  supplierVariantId: string;
  sku: string;
  existingExternalProductId: string | null;
  existingExternalVariantId: string | null;
  sellingPrice: number;
  inventory: number;
  sellable: boolean;
  withheldReason: string | null;
  label: string;
  options: Record<string, string>;
  imageAlt: string;
  attributes?: Record<string, unknown>;
};
type Plan = {
  ok: true;
  productId: string;
  productTitle: string;
  description: string;
  imageUrl: string | null;
  handle: string;
  axes: string[];
  basePrice: number | null;
  basePricePolicy: string;
  visible: boolean;
  variations: FamilyVariation[];
  excluded: Array<{ variantId: string; reason: string }>;
};
type BlockedPlan = { ok: false; reason: string };
import { addBaseItemImage, createBaseItem, editBaseItem, editBaseItemVariations, getBaseItemDetail } from "@/lib/channels/base";
import { isPublishableCatalogTitle } from "@/lib/catalog/publishable-title";
import { isJapaneseProductTitle } from "@/lib/intelligence/japanese-product";
import { ensureShopifyProductPublished, setShopifyVariantInventory, shopifyGraphQL, toShopifyGid } from "@/lib/shopify/admin";
import { getStorefrontStockCap, toStorefrontStockQuantity } from "@/lib/shopify/storefront-stock";

type Channel = "base" | "shopify";
type FamilyResult = { variantId: string; ok: boolean; externalId?: string; externalVariantId?: string; error?: string; action?: "published" | "unpublished" };
type Db = ReturnType<typeof createSupabaseAdminClient>;

const FAMILY_SYNC_PER_RUN = 2;

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function shippingDescription(description: string, visible: boolean): string {
  const cleaned = description
    .replace(/[^。！？\n]*(?:送料別|送料別途|送料込み|送料無料|送料は商品価格に含まれています)[^。！？\n]*[。！？]?/gu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const note = visible
    ? "送料込み・送料無料。日本向け送料は商品価格に含まれています。"
    : "日本向け送料・在庫・利益を確認中のため、販売を一時停止しています。";
  return [cleaned, note].filter(Boolean).join("\n\n");
}

function freshOffer(offer: Record<string, unknown> | null): boolean {
  const checkedAt = typeof offer?.last_checked_at === "string" ? Date.parse(offer.last_checked_at) : Number.NaN;
  return Number.isFinite(checkedAt) && checkedAt <= Date.now() + 5 * 60_000 && Date.now() - checkedAt <= 24 * 60 * 60_000;
}

function memberFromRow(row: Record<string, unknown>, listing: Record<string, unknown> | undefined) {
  const offers = asRelationRows(row.supplier_offers as never) as Array<Record<string, unknown>>;
  const prices = asRelationRows(row.commerce_prices as never) as Array<Record<string, unknown>>;
  prices.sort((a, b) => Date.parse(String(b.calculated_at ?? "")) - Date.parse(String(a.calculated_at ?? "")));
  const price = prices[0] ?? null;
  const offer = offers.find((item) => text(item.id) === text(price?.supplier_offer_id)) ?? offers[0] ?? null;
  const raw = offer?.raw_data && typeof offer.raw_data === "object" && !Array.isArray(offer.raw_data) ? offer.raw_data as Record<string, unknown> : {};
  const nativeIdsValid = !offer || offer.supplier_code !== "cj" || (isCanonicalCjNativeId(offer.supplier_product_id) && isCanonicalCjNativeId(offer.supplier_variant_id));
  const shippingKnown = Boolean(offer && raw.shippingEstimated !== true && (
    raw.shippingKnown === true || (raw.shippingKnown === undefined && offer.source_status === "verified" && Number(offer.shipping_cost) > 0)
  ));
  const stockKnown = raw.stockKnown === true || (raw.stockKnown === undefined && offer?.source_status === "verified");
  const evidenceFresh = freshOffer(offer);
  const missing = offer ? missingSaleEvidence({
    supplierCode: text(offer.supplier_code),
    supplierProductId: nativeIdsValid ? text(offer.supplier_product_id) : null,
    supplierVariantId: nativeIdsValid ? text(offer.supplier_variant_id) : null,
    variantSku: text(row.sku) || text(listing?.external_sku) || tracerChannelSku(text(row.id)),
    sourceStatus: text(offer.source_status),
    stockKnown,
    inventory: Number(offer.inventory),
    unitCost: Number(offer.unit_cost),
    shippingKnown,
    shipTo: text(offer.ship_to),
    trackingSupported: offer.tracking_supported === true,
    currency: text(price?.currency),
    sellingPrice: Number(price?.selling_price),
    expectedProfit: Number(price?.expected_profit),
  }) : ["supplier", "identity", "variant", "stock", "cost", "domestic_shipping", "profit", "verification"];
  if (price && Number(price.margin_rate) < 0.5) missing.push("profit");
  const attributes = row.attributes && typeof row.attributes === "object" && !Array.isArray(row.attributes) ? row.attributes as Record<string, unknown> : {};
  return {
    productId: text(row.product_id),
    variantId: text(row.id),
    supplierProductId: nativeIdsValid ? text(offer?.supplier_product_id) : "",
    supplierVariantId: nativeIdsValid ? text(offer?.supplier_variant_id) : "",
    sku: text(listing?.external_sku) || tracerChannelSku(text(row.id)),
    title: text(row.title_ja),
    supplierVariantName: text(attributes.supplierVariantName),
    sellingPrice: Number(price?.selling_price) || 0,
    marginRate: Number(price?.margin_rate),
    inventory: Number(offer?.inventory) || 0,
    evidenceFresh,
    missingEvidence: [...new Set(missing)],
    existingExternalProductId: text(listing?.external_product_id) || null,
    existingExternalVariantId: text(listing?.external_variant_id) || null,
    attributes,
  };
}

async function claimFamily(db: Db, channel: Channel, productId: string): Promise<{ key: string; lease: string } | null> {
  const key = `variant_family_sync_lock:${channel}:${productId}`;
  const now = Date.now();
  const lease = new Date(now + 3 * 60_000).toISOString();
  const { data: existing, error } = await db.from("commerce_events").select("status,detail").eq("event_key", key).maybeSingle();
  if (error) throw new Error("variant_family_lock_read_failed:" + error.message);
  const detail = existing?.detail && typeof existing.detail === "object" && !Array.isArray(existing.detail) ? existing.detail as Record<string, unknown> : {};
  const leaseUntil = typeof detail.leaseUntil === "string" ? Date.parse(detail.leaseUntil) : Number.NaN;
  if (existing?.status === "running" && Number.isFinite(leaseUntil) && leaseUntil > now) return null;
  if (!existing) {
    const { error: insertError } = await db.from("commerce_events").insert({
      event_key: key, event_type: "variant_family_sync_lock", entity_type: "commerce_product", entity_id: productId,
      status: "running", detail: { leaseUntil: lease, channel },
    });
    if (insertError) return null;
    return { key, lease };
  }
  let update = db.from("commerce_events").update({ status: "running", detail: { ...detail, leaseUntil: lease, channel } }).eq("event_key", key).eq("status", existing.status);
  if (typeof detail.leaseUntil === "string") update = update.eq("detail->>leaseUntil", detail.leaseUntil);
  const { data: won, error: updateError } = await update.select("event_key").maybeSingle();
  if (updateError || !won) return null;
  return { key, lease };
}

async function releaseFamily(db: Db, claim: { key: string; lease: string }, status: string) {
  await db.from("commerce_events").update({ status, detail: { leaseUntil: null, releasedAt: new Date().toISOString(), outcome: status } })
    .eq("event_key", claim.key).eq("status", "running").eq("detail->>leaseUntil", claim.lease);
}

async function backupListings(db: Db, channel: Channel, listings: Array<Record<string, unknown>>, reason: string) {
  if (listings.length === 0) return;
  const { error } = await db.from("channel_listing_identity_backup").insert(listings.map((row) => ({
    listing_id: row.id,
    channel,
    variant_id: row.variant_id,
    external_product_id: row.external_product_id,
    external_variant_id: row.external_variant_id,
    external_sku: row.external_sku,
    status: row.status,
    selling_price: row.selling_price,
    reason,
  })));
  if (error) throw new Error("variant_family_backup_failed:" + error.message);
}

async function rememberBlocked(db: Db, channel: Channel, productId: string, reason: string) {
  await db.from("commerce_events").upsert({
    event_key: `variant_family_blocked:${channel}:${productId}`,
    event_type: "variant_family_blocked",
    entity_type: "commerce_product",
    entity_id: productId,
    status: "blocked",
    detail: { channel, reason, at: new Date().toISOString() },
  }, { onConflict: "event_key" });
}

type ShopifyNode = { id: string; handle?: string | null; status?: string | null; vendor?: string | null; tags?: string[]; variants?: { nodes: Array<{ id: string; sku?: string | null; price?: string | null }> } };

async function findShopifyProduct(query: string): Promise<ShopifyNode[]> {
  const found = await shopifyGraphQL<{ products: { nodes: ShopifyNode[] } }>(
    `query FamilyProduct($query: String!) { products(first: 5, query: $query) { nodes { id handle vendor tags variants(first: 100) { nodes { id sku price } } } } }`,
    { query },
  );
  return (found.products?.nodes ?? []).filter((item) => item.vendor === "TRACER" || (item.tags ?? []).includes("TRACER"));
}

async function syncShopifyFamily(plan: Plan, canonicalHint: string | null) {
  const skus = new Set(plan.variations.map((variation) => variation.sku));
  let canonical = toShopifyGid("Product", canonicalHint);
  if (!canonical) {
    const byHandle = await findShopifyProduct("handle:" + plan.handle);
    if (byHandle.length > 1) throw new Error("shopify_handle_ambiguous:" + plan.handle);
    const candidate = byHandle[0] ?? null;
    const adoptable = candidate?.variants?.nodes?.every((variant) => !variant.sku || skus.has(variant.sku)) ?? false;
    if (candidate && adoptable) canonical = candidate.id;
    else if (candidate) throw new Error("shopify_product_has_unmanaged_variants:" + plan.handle);
  }
  if (canonical) {
    const current = await shopifyGraphQL<{ product: { variants?: { nodes: Array<{ sku?: string | null }> } } | null }>(
      `query FamilyProductVariants($id: ID!) { product(id: $id) { variants(first: 100) { nodes { sku } } } }`,
      { id: canonical },
    );
    const unmanaged = (current.product?.variants?.nodes ?? []).filter((variant) => variant.sku && !skus.has(variant.sku));
    if (unmanaged.length > 0) throw new Error("shopify_product_has_unmanaged_variants:" + canonical);
  }
  if (!canonical) {
    for (const sku of skus) {
      const matches = await findShopifyProduct("sku:" + sku);
      if (matches.length > 1) throw new Error("shopify_sku_ambiguous:" + sku);
      if (matches.length === 1) {
        if (canonical && canonical !== matches[0].id) throw new Error("shopify_sku_belongs_to_other_product:" + sku);
        const adoptable = matches[0].variants?.nodes?.every((variant) => !variant.sku || skus.has(variant.sku)) ?? false;
        if (!adoptable) throw new Error("shopify_product_has_unmanaged_variants:" + sku);
        canonical = matches[0].id;
      }
    }
  }
  const optionValues = new Map<string, string[]>();
  for (const axis of plan.axes) optionValues.set(axis, []);
  for (const variation of plan.variations) {
    for (const [axis, value] of Object.entries(variation.options)) {
      const values = optionValues.get(axis) ?? [];
      if (!values.includes(String(value))) values.push(String(value));
      optionValues.set(axis, values);
    }
  }
  const input: Record<string, unknown> = {
    title: plan.productTitle,
    descriptionHtml: shippingDescription(plan.description, plan.visible),
    handle: plan.handle,
    status: plan.visible ? "ACTIVE" : "DRAFT",
    vendor: "TRACER",
    productType: "TRACER Selection",
    tags: ["TRACER"],
    productOptions: plan.axes.map((name) => ({ name, values: (optionValues.get(name) ?? []).map((value) => ({ name: value })) })),
    variants: plan.variations.map((variation) => ({
      ...(variation.existingExternalVariantId && toShopifyGid("Product", variation.existingExternalProductId) === canonical
        ? { id: toShopifyGid("ProductVariant", variation.existingExternalVariantId) }
        : {}),
      sku: variation.sku,
      price: variation.sellingPrice.toFixed(2),
      inventoryPolicy: "DENY",
      optionValues: Object.entries(variation.options).map(([optionName, name]) => ({ optionName, name })),
      inventoryItem: { sku: variation.sku, tracked: true },
    })),
  };
  if (canonical) input.id = canonical;
  else if (plan.imageUrl) input.files = [{ originalSource: plan.imageUrl, alt: plan.productTitle, contentType: "IMAGE" }];
  const written = await shopifyGraphQL<{ productSet: { product: ShopifyNode | null; userErrors: Array<{ message: string }> } }>(
    `mutation FamilyProductSet($input: ProductSetInput!, $synchronous: Boolean!) {
      productSet(input: $input, synchronous: $synchronous) {
        product { id handle status variants(first: 100) { nodes { id sku price } } }
        userErrors { message }
      }
    }`,
    { input, synchronous: true },
  );
  if (written.productSet.userErrors.length || !written.productSet.product) {
    throw new Error("shopify_family_upsert_failed:" + (written.productSet.userErrors.map((error) => error.message).join("; ") || "product_missing"));
  }
  const product = written.productSet.product;
  const bySku = new Map<string, { id: string; price: number }>();
  for (const variant of product.variants?.nodes ?? []) {
    const sku = text(variant.sku);
    if (!sku || bySku.has(sku)) throw new Error("shopify_variant_sku_readback_mismatch:" + (sku || "blank"));
    const price = Math.round(Number(variant.price));
    if (!Number.isFinite(price)) throw new Error("shopify_variant_price_readback_invalid:" + sku);
    bySku.set(sku, { id: variant.id, price });
  }
  const mapped = plan.variations.map((variation) => {
    const live = bySku.get(variation.sku);
    if (!live || live.price !== Math.round(variation.sellingPrice)) throw new Error("shopify_variant_price_readback_mismatch:" + variation.sku);
    return { ...variation, externalVariantId: live.id };
  });
  const cap = getStorefrontStockCap();
  for (const variation of mapped) {
    await setShopifyVariantInventory({
      variantId: variation.externalVariantId,
      quantity: toStorefrontStockQuantity(variation.inventory, cap),
      reference: "variant-family:" + variation.variantId,
    });
  }
  const metafields = mapped.map((variation) => ({
    ownerId: variation.externalVariantId,
    namespace: "tracer",
    key: "cj_variant_id",
    type: "single_line_text_field",
    value: variation.supplierVariantId,
  }));
  const savedMeta = await shopifyGraphQL<{ metafieldsSet: { userErrors: Array<{ message: string }> } }>(
    `mutation FamilyCjIds($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { message } } }`,
    { metafields },
  );
  if (savedMeta.metafieldsSet.userErrors.length) throw new Error("shopify_cj_variant_id_save_failed:" + savedMeta.metafieldsSet.userErrors.map((error) => error.message).join("; "));
  if (plan.visible) {
    const publication = await ensureShopifyProductPublished(product.id);
    if (!publication.published) throw new Error("shopify_publication_not_confirmed");
  }
  const domain = String(process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "");
  return { externalProductId: product.id, publishedUrl: domain ? "https://" + domain + "/products/" + product.handle : null, mapped };
}

async function syncBaseFamily(plan: Plan, canonicalHint: string | null, db: Db, listingsByVariant: Map<string, Record<string, unknown>>) {
  let itemId = canonicalHint;
  if (!itemId) {
    const marker = listingsByVariant.values();
    for (const listing of marker) {
      const matched = text(listing.last_error).match(/^base_create_id_persist_failed:([^:]+)/);
      if (matched?.[1]) itemId = matched[1];
    }
  }
  const detail = shippingDescription(plan.description, plan.visible);
  const price = plan.basePrice ?? Math.max(...plan.variations.map((variation) => variation.sellingPrice), 1);
  if (!itemId) {
    if (!plan.visible) return { externalProductId: null, publishedUrl: null, mapped: [] as Array<Plan["variations"][number] & { externalVariantId: string }> };
    const created = await createBaseItem({ title: plan.productTitle, identifier: "TRC-P" + plan.productId.replace(/-/g, "").slice(0, 20).toUpperCase(), detail, price, stock: 0, visible: false });
    itemId = text(created.item?.item_id ?? created.item_id);
    if (!itemId) throw new Error("base_item_id_missing");
    const anchor = plan.variations[0];
    const { error } = await db.from("channel_listings").upsert({
      variant_id: anchor.variantId, channel: "base", external_product_id: itemId, external_sku: anchor.sku,
      selling_price: anchor.sellingPrice, status: "pending", last_error: null, updated_at: new Date().toISOString(),
    }, { onConflict: "channel,variant_id" });
    if (error) throw new Error("base_create_id_persist_failed:" + itemId + ":" + error.message);
  }
  const existingDetail = await getBaseItemDetail(itemId);
  const existingVariations = Array.isArray(existingDetail.variations) ? existingDetail.variations as Array<Record<string, unknown>> : [];
  const variationIdBySku = new Map(existingVariations.map((variation) => [text(variation.variation_identifier).toUpperCase(), text(variation.variation_id)]));
  const cap = getStorefrontStockCap();
  const variationPayload = (ids: Map<string, string>) => plan.variations.map((variation) => ({
    variationId: ids.get(variation.sku.toUpperCase()) || null,
    name: variation.label,
    stock: toStorefrontStockQuantity(variation.inventory, cap),
    identifier: variation.sku,
  }));
  await editBaseItemVariations({ itemId, title: plan.productTitle, detail, price, visible: false, variations: variationPayload(variationIdBySku) });
  const afterCreate = await getBaseItemDetail(itemId);
  const createdVariations = Array.isArray(afterCreate.variations) ? afterCreate.variations as Array<Record<string, unknown>> : [];
  const createdIds = new Map(createdVariations.map((variation) => [text(variation.variation_identifier).toUpperCase(), text(variation.variation_id)]));
  if (plan.imageUrl) await addBaseItemImage({ itemId, imageNo: 1, imageUrl: plan.imageUrl });
  const visible = await editBaseItemVariations({
    itemId, title: plan.productTitle, detail, price, visible: plan.visible, variations: variationPayload(createdIds),
  });
  const readback = await getBaseItemDetail(itemId);
  const actualPrice = Math.round(Number(readback.price));
  if (actualPrice !== Math.round(price)) throw new Error("base_family_price_readback_mismatch:expected=" + price + ":actual=" + actualPrice);
  const liveVariations = Array.isArray(readback.variations) ? readback.variations as Array<Record<string, unknown>> : [];
  const mapped = plan.variations.map((variation) => {
    const live = liveVariations.filter((item) => text(item.variation_identifier).toUpperCase() === variation.sku.toUpperCase());
    if (live.length !== 1 || !text(live[0].variation_id)) throw new Error("base_variation_readback_mismatch:" + variation.sku);
    const stock = Number(live[0].variation_stock);
    const expected = toStorefrontStockQuantity(variation.inventory, cap);
    if (stock !== expected) throw new Error("base_variation_stock_readback_mismatch:" + variation.sku);
    return { ...variation, externalVariantId: text(live[0].variation_id) };
  });
  if (plan.visible && (readback.visible === false || readback.visible === 0 || readback.visible === "0")) {
    throw new Error("base_family_visibility_readback_mismatch");
  }
  return { externalProductId: itemId, publishedUrl: null, mapped, baseResponse: visible };
}

async function syncOneFamily(db: Db, channel: Channel, productId: string, candidateIds: Set<string>): Promise<FamilyResult[]> {
  const { data: rows, error } = await db.from("commerce_variants")
    .select("id,product_id,title_ja,sku,attributes,commerce_products!inner(id,source_key,title_ja,description_ja,image_url,active),supplier_offers(id,supplier_code,supplier_product_id,supplier_variant_id,currency,unit_cost,shipping_cost,raw_data,inventory,ship_to,tracking_supported,source_status,last_checked_at),commerce_prices(supplier_offer_id,calculated_at,currency,selling_price,expected_profit,fee_amount,margin_rate)")
    .eq("product_id", productId)
    .eq("commerce_products.active", true);
  if (error) throw new Error("variant_family_read_failed:" + error.message);
  const variants = (rows ?? []) as Array<Record<string, unknown>>;
  if (variants.length < 2) return [];
  const variantIds = variants.map((row) => text(row.id));
  const { data: listingRows, error: listingError } = await db.from("channel_listings")
    .select("id,variant_id,channel,external_product_id,external_variant_id,external_sku,status,selling_price,last_error")
    .eq("channel", channel)
    .in("variant_id", variantIds);
  if (listingError) throw new Error("variant_family_listing_read_failed:" + listingError.message);
  const listings = (listingRows ?? []) as Array<Record<string, unknown>>;
  const listingsByVariant = new Map(listings.map((row) => [text(row.variant_id), row]));
  const product = asRelationRows(variants[0].commerce_products as never)[0] as Record<string, unknown> | undefined;
  const members = variants.map((row) => memberFromRow(row, listingsByVariant.get(text(row.id))));
  const planned = planVariantFamily({
    productId,
    sourceKey: text(product?.source_key),
    productTitle: text(product?.title_ja),
    description: text(product?.description_ja),
    imageUrl: text(product?.image_url) || null,
    members,
  }) as Plan | BlockedPlan;
  const touched = (variantId: string) => candidateIds.has(variantId);
  if (!planned.ok) {
    await rememberBlocked(db, channel, productId, planned.reason);
    return variantIds.filter(touched).map((variantId) => ({ variantId, ok: false, error: "variant_family_blocked:" + planned.reason }));
  }
  const sellablePriced = planned.variations.filter((variation) => variation.sellable && variation.sellingPrice > 0);
  if (sellablePriced.length === 0) {
    await rememberBlocked(db, channel, productId, "variant_family_no_sellable_price");
    return variantIds.filter(touched).map((variantId) => ({ variantId, ok: false, error: "variant_family_blocked:variant_family_no_sellable_price" }));
  }
  // Keep every supplier-identified color/size in the shared parent. A variant
  // without a verified price receives the family's reference price but remains
  // hidden with zero stock; it is never made purchasable by this fallback.
  const referencePrice = Math.max(...planned.variations.map((variation) => variation.sellingPrice).filter((price) => price > 0));
  const familyVariations = planned.variations.map((variation) => ({
    ...variation,
    sellingPrice: variation.sellingPrice > 0 ? variation.sellingPrice : referencePrice,
    sellable: variation.sellable && variation.sellingPrice > 0,
    inventory: variation.sellable && variation.sellingPrice > 0 ? variation.inventory : 0,
    withheldReason: variation.sellingPrice > 0 ? variation.withheldReason : "price_unavailable",
  }));
  const plan: Plan = { ...planned, variations: familyVariations };
  if (!isJapaneseProductTitle(plan.productTitle) || !isPublishableCatalogTitle(plan.productTitle)) {
    await rememberBlocked(db, channel, productId, "japanese_product_title_invalid");
    return variantIds.filter(touched).map((variantId) => ({ variantId, ok: false, error: "japanese_product_title_invalid" }));
  }
  if (plan.visible && !plan.imageUrl) {
    return variantIds.filter(touched).map((variantId) => ({ variantId, ok: false, error: "image_url_invalid" }));
  }
  const claim = await claimFamily(db, channel, productId);
  if (!claim) return variantIds.filter(touched).map((variantId) => ({ variantId, ok: false, error: "variant_family_sync_in_progress" }));
  try {
    await backupListings(db, channel, listings, "variant_family_sync:" + channel + ":" + productId);
    const canonical = chooseCanonicalExternalProductId(plan.variations);
    const synced = channel === "shopify"
      ? await syncShopifyFamily(plan, canonical)
      : await syncBaseFamily(plan, canonical, db, listingsByVariant);
    if (!synced.externalProductId) {
      return variantIds.filter(touched).map((variantId) => ({ variantId, ok: false, error: "variant_family_not_sellable" }));
    }
    const now = new Date().toISOString();
    for (const variation of synced.mapped) {
      const status = variation.sellable ? "published" : "hidden";
      const { error: saveError } = await db.from("channel_listings").upsert({
        variant_id: variation.variantId,
        channel,
        external_product_id: synced.externalProductId,
        external_variant_id: variation.externalVariantId,
        external_sku: variation.sku,
        selling_price: Math.max(1, Math.round(variation.sellingPrice)),
        status,
        published_url: synced.publishedUrl,
        last_error: variation.sellable ? null : "variant_withheld:" + (variation.withheldReason ?? "not_sellable"),
        last_synced_at: now,
        updated_at: now,
      }, { onConflict: "channel,variant_id" });
      if (saveError) throw new Error("variant_family_listing_save_failed:" + saveError.message);
      const previous = members.find((member) => member.variantId === variation.variantId);
      await db.from("commerce_variants").update({
        attributes: { ...(previous?.attributes ?? {}), variationLabel: variation.label, color: variation.options["色"] ?? null, size: variation.options["サイズ"] ?? null, cjVariantId: variation.supplierVariantId },
        updated_at: now,
      }).eq("id", variation.variantId);
    }
    const abandoned = [...new Set(plan.variations.map((variation) => text(variation.existingExternalProductId)).filter((id) => id && id !== synced.externalProductId))];
    for (const abandonedId of abandoned) {
      if (channel === "shopify") {
        const productIdGid = toShopifyGid("Product", abandonedId);
        if (!productIdGid) continue;
        const hidden = await shopifyGraphQL<{ productUpdate: { userErrors: Array<{ message: string }> } }>(
          `mutation FamilyDraftDuplicate($input: ProductUpdateInput!) { productUpdate(product: $input) { userErrors { message } } }`,
          { input: { id: productIdGid, status: "DRAFT" } },
        );
        if (hidden.productUpdate.userErrors.length) throw new Error("shopify_duplicate_draft_failed:" + hidden.productUpdate.userErrors.map((entry) => entry.message).join("; "));
      } else {
        await editBaseItem({ itemId: abandonedId, title: plan.productTitle, detail: shippingDescription(plan.description, false), price: plan.basePrice ?? 1, stock: 0, visible: false });
      }
    }
    await db.from("commerce_events").upsert({
      event_key: `variant_family_synced:${channel}:${productId}`,
      event_type: "variant_family_synced",
      entity_type: "commerce_product",
      entity_id: productId,
      status: "ok",
      detail: {
        channel,
        externalProductId: synced.externalProductId,
        basePricePolicy: plan.basePricePolicy,
        basePrice: plan.basePrice,
        variations: synced.mapped.map((variation) => ({ variantId: variation.variantId, sku: variation.sku, supplierVariantId: variation.supplierVariantId, sellable: variation.sellable })),
        excluded: plan.excluded,
        syncedAt: now,
      },
    }, { onConflict: "event_key" });
    return synced.mapped.filter((variation) => touched(variation.variantId)).map((variation) => ({
      variantId: variation.variantId,
      ok: true,
      externalId: synced.externalProductId ?? undefined,
      externalVariantId: variation.externalVariantId,
      action: variation.sellable ? "published" as const : "unpublished" as const,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();
    for (const variantId of variantIds.filter(touched)) {
      await db.from("channel_listings").update({ last_error: message.slice(0, 1500), last_synced_at: now, updated_at: now })
        .eq("channel", channel).eq("variant_id", variantId);
    }
    return variantIds.filter(touched).map((variantId) => ({ variantId, ok: false, error: message.slice(0, 300) }));
  } finally {
    await releaseFamily(db, claim, "idle");
  }
}

async function splitFamilyVariantIds(db: Db, channel: Channel): Promise<string[]> {
  const { data, error } = await db.from("commerce_variants")
    .select("id,product_id,channel_listings!inner(channel,external_product_id)")
    .eq("channel_listings.channel", channel)
    .limit(1000);
  if (error) throw new Error("variant_family_split_read_failed:" + error.message);
  const groups = new Map<string, Array<{ id: string; externalProductId: string }>>();
  for (const row of data ?? []) {
    const productId = text(row.product_id);
    const listings = asRelationRows(row.channel_listings as never) as Array<Record<string, unknown>>;
    const externalProductId = text(listings.find((listing) => text(listing.channel) === channel)?.external_product_id);
    const rows = groups.get(productId) ?? [];
    rows.push({ id: text(row.id), externalProductId });
    groups.set(productId, rows);
  }
  const ids: string[] = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const distinct = new Set(rows.map((row) => row.externalProductId).filter(Boolean));
    if (distinct.size > 1) ids.push(...rows.map((row) => row.id));
    if (ids.length >= 40) break;
  }
  return ids;
}

async function familySchemaReady(db: Db): Promise<boolean> {
  const { error } = await db.from("channel_listing_identity_backup").select("id").limit(1);
  return !error;
}

export async function syncQueuedVariantFamilies(input: { channel: Channel; variantIds: string[] }): Promise<{ handledVariantIds: string[]; results: FamilyResult[] }> {
  const db = createSupabaseAdminClient();
  if (!(await familySchemaReady(db))) return { handledVariantIds: [], results: [] };
  const variantIds = [...new Set([...(await splitFamilyVariantIds(db, input.channel)), ...input.variantIds.map(text)].filter(Boolean))];
  if (variantIds.length === 0) return { handledVariantIds: [], results: [] };
  const { data: seeds, error } = await db.from("commerce_variants").select("id,product_id").in("id", variantIds);
  if (error) throw new Error("variant_family_seed_read_failed:" + error.message);
  const productIds = [...new Set((seeds ?? []).map((row) => text(row.product_id)).filter(Boolean))];
  if (productIds.length === 0) return { handledVariantIds: [], results: [] };
  const { data: siblings, error: siblingError } = await db.from("commerce_variants").select("id,product_id").in("product_id", productIds);
  if (siblingError) throw new Error("variant_family_sibling_read_failed:" + siblingError.message);
  const byProduct = new Map<string, string[]>();
  for (const row of siblings ?? []) {
    const productId = text(row.product_id);
    const id = text(row.id);
    byProduct.set(productId, [...(byProduct.get(productId) ?? []), id]);
  }
  const candidateOrder = new Map(variantIds.map((id, index) => [id, index]));
  const multi = productIds
    .filter((productId) => (byProduct.get(productId)?.length ?? 0) >= 2)
    .sort((a, b) => {
      const aIndex = Math.min(...(byProduct.get(a) ?? []).map((id) => candidateOrder.get(id) ?? 9999));
      const bIndex = Math.min(...(byProduct.get(b) ?? []).map((id) => candidateOrder.get(id) ?? 9999));
      return aIndex - bIndex;
    });
  const results: FamilyResult[] = [];
  const handled = new Set<string>();
  const candidateIds = new Set(variantIds);
  const singlePublishError = /^(variant_family_blocked:|japanese_product_title_invalid|image_url_invalid|variant_family_not_sellable)/;
  let apiSyncs = 0;
  for (const productId of multi) {
    if (apiSyncs >= FAMILY_SYNC_PER_RUN) break;
    const familyResults = await syncOneFamily(db, input.channel, productId, candidateIds);
    results.push(...familyResults);
    const leaveSeparate = familyResults.length > 0 && familyResults.every((row) => singlePublishError.test(String(row.error ?? "")));
    if (leaveSeparate) continue;
    for (const id of byProduct.get(productId) ?? []) if (candidateOrder.has(id)) handled.add(id);
    const calledChannel = familyResults.some((row) => row.ok || !String(row.error ?? "").startsWith("variant_family_sync_in_progress"));
    if (calledChannel) apiSyncs += 1;
  }
  return { handledVariantIds: [...handled], results };
}

export type { Plan };
