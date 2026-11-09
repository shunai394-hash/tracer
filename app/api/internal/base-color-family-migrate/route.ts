import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import {
  addBaseItemImage,
  createBaseItem,
  editBaseItem,
  fetchBaseItemsSnapshot,
  getBaseItemDetail,
  getBasePublicShopUrl,
  isBaseConfigured,
  BASE_ITEMS_MAX_PAGES,
} from "@/lib/channels/base";
import { shopifyGraphQL } from "@/lib/shopify/admin";
import { getStorefrontStockCap, toStorefrontStockQuantity } from "@/lib/shopify/storefront-stock";
import { resolveBasePublicUrl } from "@/lib/commerce/base-public-url.mjs";

export const runtime = "nodejs";
export const maxDuration = 300;

type Row = Record<string, unknown>;

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function colorLabel(variant: Row): string {
  const attributes = record(variant.attributes);
  const fromAttributes = String(attributes.colorLabel ?? attributes.color_label ?? "").trim();
  if (fromAttributes) return fromAttributes;
  const title = String(variant.title_ja ?? "").trim();
  const match = title.match(/（([^（）]+)）$/);
  return match?.[1]?.trim() ?? "";
}

function validHttps(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function baseSafeText(value: unknown): string {
  return String(value ?? "").replace(/\p{Extended_Pictographic}/gu, "").trim();
}

function isVisible(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function itemImages(item: Row): string[] {
  return Array.from({ length: 20 }, (_, index) => String(item[`img${index + 1}_origin`] ?? item[`img${index + 1}`] ?? "").trim())
    .filter(Boolean);
}

export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (!isBaseConfigured()) return NextResponse.json({ ok: false, error: "base_oauth_not_configured" }, { status: 503 });

  const body = await request.json().catch(() => ({}));
  const supplierProductId = String(record(body).supplierProductId ?? "").trim();
  if (!/^\d{10,22}$/.test(supplierProductId)) {
    return NextResponse.json({ ok: false, error: "invalid_supplier_product_id" }, { status: 400 });
  }

  const db = createSupabaseAdminClient();
  const now = new Date();
  const nowIso = now.toISOString();
  try {
    const publicShopUrl = (await getBasePublicShopUrl()) ?? process.env.BASE_PUBLIC_SHOP_URL?.trim() ?? "";
    if (!publicShopUrl) throw new Error("base_color_family_public_shop_url_missing");
    const { data: product, error: productError } = await db.from("commerce_products")
      .select("id,source_key,title_ja,description_ja")
      .eq("source_key", "cj:" + supplierProductId)
      .maybeSingle();
    if (productError || !product) throw new Error("base_color_family_product_missing:" + (productError?.message ?? "not_found"));

    const { data: variants, error: variantsError } = await db.from("commerce_variants")
      .select("id,product_id,source_variant_key,sku,title_ja,attributes")
      .eq("product_id", String(product.id))
      .order("source_variant_key", { ascending: true });
    if (variantsError) throw new Error("base_color_family_variants_read_failed:" + variantsError.message);
    if (!variants || variants.length < 2 || variants.length > 20) throw new Error("base_color_family_variant_count_invalid");

    const variantIds = variants.map((variant) => String(variant.id));
    const [{ data: offers, error: offersError }, { data: prices, error: pricesError }, { data: channelRows, error: channelError }] = await Promise.all([
      db.from("supplier_offers")
        .select("variant_id,supplier_product_id,supplier_variant_id,source_status,ship_to,inventory,unit_cost,shipping_cost,tracking_supported,last_checked_at")
        .eq("supplier_code", "cj").in("variant_id", variantIds),
      db.from("commerce_prices")
        .select("variant_id,currency,selling_price,expected_profit,margin_rate")
        .in("variant_id", variantIds),
      db.from("channel_listings")
        .select("variant_id,channel,external_product_id,external_variant_id,external_sku,status,published_url")
        .in("variant_id", variantIds),
    ]);
    if (offersError || pricesError || channelError) {
      throw new Error("base_color_family_evidence_read_failed:" + (offersError?.message ?? pricesError?.message ?? channelError?.message));
    }
    if ((offers ?? []).length !== variants.length || (prices ?? []).length !== variants.length) {
      throw new Error("base_color_family_evidence_count_mismatch");
    }

    const offersByVariant = new Map((offers ?? []).map((row) => [String(row.variant_id), row] as const));
    const pricesByVariant = new Map((prices ?? []).map((row) => [String(row.variant_id), row] as const));
    const channelByKey = new Map((channelRows ?? []).map((row) => [String(row.channel) + ":" + String(row.variant_id), row] as const));
    const cap = getStorefrontStockCap();
    const prepared = variants.map((variant) => {
      const variantId = String(variant.id);
      const supplierVariantId = String(variant.source_variant_key ?? "");
      const offer = offersByVariant.get(variantId);
      const price = pricesByVariant.get(variantId);
      const attributes = record(variant.attributes);
      const label = colorLabel(variant);
      const imageSource = String(attributes.variantImageUrl ?? "").trim();
      const checkedAt = Date.parse(String(offer?.last_checked_at ?? ""));
      if (!variant.sku || !supplierVariantId || !label ||
          !offer || String(offer.supplier_product_id) !== supplierProductId ||
          String(offer.supplier_variant_id) !== supplierVariantId ||
          offer.source_status !== "verified" || offer.ship_to !== "JP" || offer.tracking_supported !== true ||
          Number(offer.inventory) < 1 || Number(offer.unit_cost) <= 0 || Number(offer.shipping_cost) <= 0 ||
          !Number.isFinite(checkedAt) || checkedAt > now.getTime() + 5 * 60_000 ||
          now.getTime() - checkedAt > 24 * 60 * 60_000) {
        throw new Error("base_color_family_supplier_gate_failed:" + String(variant.sku ?? variantId));
      }
      if (!price || price.currency !== "JPY" || Number(price.selling_price) <= 0 ||
          Number(price.expected_profit) < 2500 || Number(price.margin_rate) < 0.5) {
        throw new Error("base_color_family_price_gate_failed:" + String(variant.sku ?? variantId));
      }
      if (attributes.variantImageIdentityVerified !== true || attributes.colorImageVerified !== true || !validHttps(imageSource)) {
        throw new Error("base_color_family_exact_image_unverified:" + String(variant.sku ?? variantId));
      }
      const shopify = channelByKey.get("shopify:" + variantId);
      if (!shopify || shopify.status !== "published" || !shopify.external_variant_id) {
        throw new Error("base_color_family_shopify_image_source_missing:" + String(variant.sku ?? variantId));
      }
      return {
        id: variantId,
        sku: String(variant.sku),
        supplierVariantId,
        label,
        imageSource,
        price: Math.round(Number(price.selling_price)),
        stock: toStorefrontStockQuantity(offer.inventory, cap),
        shopifyVariantId: String(shopify.external_variant_id),
      };
    });

    if (new Set(prepared.map((variant) => variant.label)).size !== prepared.length ||
        new Set(prepared.map((variant) => variant.supplierVariantId)).size !== prepared.length ||
        new Set(prepared.map((variant) => variant.imageSource)).size !== prepared.length) {
      throw new Error("base_color_family_variant_identity_ambiguous");
    }
    const commonPrice = prepared[0].price;
    if (prepared.some((variant) => variant.price !== commonPrice)) {
      throw new Error("base_color_family_price_mismatch");
    }

    const shopifyImages = await Promise.all(prepared.map(async (variant) => {
      const result = await shopifyGraphQL<{
        productVariant: {
          id: string;
          sku: string | null;
          selectedOptions: Array<{ name: string; value: string }>;
          metafields: { nodes: Array<{ key: string; value: string }> };
          media: { nodes: Array<{ alt: string | null; image: { url: string } | null }> };
        } | null;
      }>(
        `query ReadBaseColorVariantImage($id: ID!) {
          productVariant(id: $id) {
            id sku selectedOptions { name value }
            metafields(first: 10, namespace: "tracer") { nodes { key value } }
            media(first: 5) { nodes { alt ... on MediaImage { image { url } } } }
          }
        }`,
        { id: variant.shopifyVariantId },
      );
      const actual = result.productVariant;
      if (!actual || actual.sku !== variant.sku ||
          !actual.selectedOptions.some((option) => option.name === "カラー" && option.value === variant.label)) {
        throw new Error("base_color_family_shopify_variant_identity_mismatch:" + variant.sku);
      }
      const fields = new Map(actual.metafields.nodes.map((field) => [field.key, field.value] as const));
      if (fields.get("supplier_variant_id") !== variant.supplierVariantId ||
          fields.get("color_image_source_url") !== variant.imageSource) {
        throw new Error("base_color_family_shopify_supplier_image_identity_mismatch:" + variant.sku);
      }
      const media = actual.media.nodes.filter((node) => validHttps(node.image?.url));
      const mediaAlt = String(media[0]?.alt ?? "").normalize("NFKC").trim();
      const normalizedLabel = variant.label.normalize("NFKC").trim();
      const mediaAltMatchesColor = mediaAlt === normalizedLabel ||
        mediaAlt.endsWith(" " + normalizedLabel) ||
        mediaAlt.endsWith("　" + normalizedLabel);
      if (media.length !== 1 || !mediaAltMatchesColor) {
        throw new Error("base_color_family_shopify_variant_media_unverified:" + variant.sku);
      }
      return { ...variant, imageUrl: media[0].image!.url };
    }));

    const oldRows = (channelRows ?? []).filter((row) => row.channel === "base");
    if (oldRows.length !== prepared.length || oldRows.some((row) => !String(row.external_product_id ?? "").trim())) {
      throw new Error("base_color_family_legacy_base_mapping_missing");
    }
    const { data: priorAliases, error: priorAliasError } = await db.from("channel_listing_external_aliases")
      .select("variant_id,external_product_id,external_variant_id")
      .eq("channel", "base")
      .in("variant_id", variantIds);
    if (priorAliasError) throw new Error("base_color_family_prior_alias_read_failed:" + priorAliasError.message);
    const oldItemIds = [...new Set([
      ...oldRows.map((row) => String(row.external_product_id)),
      ...(priorAliases ?? []).map((row) => String(row.external_product_id)),
    ].filter((id) => /^\\d+$/.test(id)))];

    const identifier = "TRC-COLOR-FAMILY-" + supplierProductId;
    const groupedBaseItemIds = [...new Set(oldRows
      .filter((row) => row.external_variant_id && String(row.external_variant_id) !== String(row.external_product_id))
      .map((row) => String(row.external_product_id)))];
    if (groupedBaseItemIds.length > 1) throw new Error("base_color_family_existing_grouped_item_ambiguous");
    const snapshot = await fetchBaseItemsSnapshot({ itemPageLimit: 100, itemMaxPages: BASE_ITEMS_MAX_PAGES });
    if (snapshot.complete !== true) throw new Error("base_color_family_recovery_snapshot_incomplete");
    const matches = snapshot.items.filter((item) => String(item.identifier ?? "").trim() === identifier);
    if (matches.length > 1) throw new Error("base_color_family_base_identifier_ambiguous");
    const snapshotItemId = matches[0] ? String(matches[0].item_id) : "";
    if (groupedBaseItemIds.length && snapshotItemId && groupedBaseItemIds[0] !== snapshotItemId) {
      throw new Error("base_color_family_existing_item_identity_conflict");
    }
    const expectedBySupplierId = new Map(prepared.map((variant) => [variant.supplierVariantId, variant] as const));
    let itemId = groupedBaseItemIds[0] ?? snapshotItemId;
    let baseItem = itemId ? await getBaseItemDetail(itemId) : null;
    const existingVariations = rows(baseItem?.variations);
    const existingByIdentifier = new Map<string, Row>();
    for (const variation of existingVariations) {
      const variationIdentifier = String(variation.variation_identifier ?? "");
      if (!variationIdentifier || existingByIdentifier.has(variationIdentifier)) {
        throw new Error("base_color_family_existing_variation_identity_ambiguous");
      }
      existingByIdentifier.set(variationIdentifier, variation);
    }
    if (existingVariations.length && existingVariations.some((variation) => !expectedBySupplierId.has(String(variation.variation_identifier)))) {
      throw new Error("base_color_family_existing_variation_conflict");
    }

    const variationInputs = prepared.map((variant) => {
      const existing = existingByIdentifier.get(variant.supplierVariantId);
      if (existing && String(existing.variation ?? "") !== variant.label) {
        throw new Error("base_color_family_existing_variation_label_conflict:" + variant.sku);
      }
      return {
        ...(existing ? { id: String(existing.variation_id) } : {}),
        name: variant.label,
        stock: variant.stock,
        identifier: variant.supplierVariantId,
      };
    });
    const totalStock = variationInputs.reduce((sum, variation) => sum + variation.stock, 0);
    const title = baseSafeText(product.title_ja);
    const detail = baseSafeText(product.description_ja) || title;
    if (!title) throw new Error("base_color_family_title_missing");

    if (!itemId) {
      const created = await createBaseItem({
        title,
        identifier,
        detail,
        price: commonPrice,
        stock: totalStock,
        visible: false,
        variations: variationInputs,
      });
      itemId = String(created.item?.item_id ?? created.item_id ?? "");
      if (!/^\d+$/.test(itemId)) throw new Error("base_color_family_create_missing_item_id");
      baseItem = await getBaseItemDetail(itemId);
    } else {
      await editBaseItem({
        itemId,
        title,
        detail,
        price: commonPrice,
        stock: totalStock,
        visible: baseItem ? isVisible(baseItem.visible) : false,
        variations: variationInputs,
      });
      baseItem = await getBaseItemDetail(itemId);
    }

    const readVariations = rows(baseItem?.variations);
    const readByIdentifier = new Map(readVariations.map((variation) => [String(variation.variation_identifier ?? ""), variation] as const));
    if (readVariations.length !== prepared.length) throw new Error("base_color_family_variation_count_readback_failed");
    for (const variant of prepared) {
      const actual = readByIdentifier.get(variant.supplierVariantId);
      if (!actual || String(actual.variation ?? "") !== variant.label ||
          Number(actual.variation_stock) !== variant.stock || !String(actual.variation_id ?? "").trim()) {
        throw new Error("base_color_family_variation_readback_failed:" + variant.sku);
      }
    }

    const imageSlots = Array.from({ length: 20 }, (_, index) => String(baseItem?.[`img${index + 1}_origin`] ?? baseItem?.[`img${index + 1}`] ?? "").trim());
    for (const [index, variant] of shopifyImages.entries()) {
      if (imageSlots[index]) continue;
      await addBaseItemImage({ itemId, imageNo: index + 1, imageUrl: variant.imageUrl });
    }
    baseItem = await getBaseItemDetail(itemId);
    const finalImages = itemImages(baseItem);
    if (finalImages.length < prepared.length) throw new Error("base_color_family_image_gallery_readback_failed");

    const publishedUrl = resolveBasePublicUrl({ item: baseItem }, itemId, publicShopUrl) ??
      new URL("/items/" + itemId, publicShopUrl).toString();
    if (!publishedUrl) throw new Error("base_color_family_public_url_missing");

    const aliases = oldRows.flatMap((row) => {
      const oldProductId = String(row.external_product_id ?? "");
      const oldVariantId = String(row.external_variant_id ?? oldProductId);
      if (!oldProductId || !oldVariantId || oldProductId === itemId) return [];
      return [{
        channel: "base",
        variant_id: String(row.variant_id),
        external_product_id: oldProductId,
        external_variant_id: oldVariantId,
      }];
    });
    const aliasesPreservedCount = new Set([
      ...(priorAliases ?? []).map((alias) => String(alias.external_variant_id)),
      ...aliases.map((alias) => alias.external_variant_id),
    ]).size;
    if (new Set(aliases.map((alias) => alias.external_variant_id)).size !== aliases.length) {
      throw new Error("base_color_family_legacy_alias_identity_collision");
    }
    if (aliases.length) {
      const { data: existingAliases, error: aliasReadError } = await db.from("channel_listing_external_aliases")
        .select("variant_id,external_product_id,external_variant_id")
        .eq("channel", "base")
        .in("external_variant_id", aliases.map((alias) => alias.external_variant_id));
      if (aliasReadError) throw new Error("base_color_family_alias_read_failed:" + aliasReadError.message);
      for (const alias of existingAliases ?? []) {
        const expected = aliases.find((item) => item.external_variant_id === String(alias.external_variant_id));
        if (expected && (String(alias.variant_id) !== expected.variant_id ||
            String(alias.external_product_id) !== expected.external_product_id)) {
          throw new Error("base_color_family_alias_identity_conflict:" + String(alias.external_variant_id));
        }
      }
      const { error: aliasWriteError } = await db.from("channel_listing_external_aliases")
        .upsert(aliases, { onConflict: "channel,external_variant_id" });
      if (aliasWriteError) throw new Error("base_color_family_alias_write_failed:" + aliasWriteError.message);
    }

    for (const variant of prepared) {
      const actual = readByIdentifier.get(variant.supplierVariantId);
      const { error: listingUpdateError } = await db.from("channel_listings").update({
        external_product_id: itemId,
        external_variant_id: String(actual?.variation_id),
        external_sku: variant.sku,
        selling_price: commonPrice,
        status: "pending",
        published_url: publishedUrl,
        last_error: null,
        last_synced_at: nowIso,
        updated_at: nowIso,
      }).eq("channel", "base").eq("variant_id", variant.id);
      if (listingUpdateError) throw new Error("base_color_family_listing_update_failed:" + variant.sku + ":" + listingUpdateError.message);
    }

    if (!isVisible(baseItem.visible)) {
      await editBaseItem({ itemId, visible: true });
    }
    baseItem = await getBaseItemDetail(itemId);
    if (!isVisible(baseItem.visible) || rows(baseItem.variations).length !== prepared.length) {
      throw new Error("base_color_family_publication_readback_failed");
    }
    for (const variant of prepared) {
      const { error: publishedStateError } = await db.from("channel_listings").update({
        status: "published",
        last_error: null,
        last_synced_at: nowIso,
        updated_at: nowIso,
      }).eq("channel", "base").eq("variant_id", variant.id);
      if (publishedStateError) throw new Error("base_color_family_published_state_save_failed:" + variant.sku + ":" + publishedStateError.message);
    }

    const hiddenOldItems: string[] = [];
    for (const oldItemId of oldItemIds) {
      if (oldItemId === itemId) continue;
      const old = await getBaseItemDetail(oldItemId);
      if (isVisible(old.visible) || Number(old.stock) > 0) {
        const oldVariations = rows(old.variations);
        if (oldVariations.length) {
          await editBaseItem({
            itemId: oldItemId,
            visible: false,
            variations: oldVariations.map((variation) => ({
              id: String(variation.variation_id),
              name: String(variation.variation ?? ""),
              stock: 0,
              identifier: variation.variation_identifier == null ? undefined : String(variation.variation_identifier),
            })),
          });
        } else {
          await editBaseItem({ itemId: oldItemId, stock: 0, visible: false });
        }
      }
      const hidden = await getBaseItemDetail(oldItemId);
      if (isVisible(hidden.visible) || Number(hidden.stock) !== 0) {
        throw new Error("base_color_family_old_item_hide_failed:" + oldItemId);
      }
      hiddenOldItems.push(oldItemId);
    }

    return NextResponse.json({
      ok: true,
      status: "PUBLISHED",
      supplierProductId,
      itemId,
      publishedUrl,
      variationCount: readVariations.length,
      variations: prepared.map((variant) => ({
        sku: variant.sku,
        supplierVariantId: variant.supplierVariantId,
        variationId: String(readByIdentifier.get(variant.supplierVariantId)?.variation_id),
        colorLabel: variant.label,
        stock: variant.stock,
      })),
      imageCount: finalImages.length,
      oldItemsHidden: hiddenOldItems,
      aliasesPreserved: aliasesPreservedCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[TRACER BASE COLOR FAMILY MIGRATION FAILED]", message);
    return NextResponse.json({ ok: false, error: message.slice(0, 240) }, { status: 502 });
  }
}
