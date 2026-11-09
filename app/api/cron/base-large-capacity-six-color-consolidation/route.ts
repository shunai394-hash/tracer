import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  addBaseItemImage,
  editBaseItem,
  getBaseItemDetail,
  isBaseConfigured,
} from "@/lib/channels/base";

export const runtime = "nodejs";
export const maxDuration = 120;

const PRODUCT_ID = "7552ee45-64f7-4f9b-8a4c-026f85ec5a97";
const PARENT_ID = "165149839";
const PARENT_TITLE = "大容量・斜めがけ レディースハンドバッグ";
const BASE_ITEM_TITLE = "レディース クロスボディバッグ";
const PRICE = 5824;
const COLOR_STOCK = 10;
const TARGETS = [
  { itemId: "165149839", color: "カーキ", variantId: "b8a81003-ca31-41d2-b092-49a053ffc907", supplierSku: "CJNS325064801AZ", externalSku: "TRC-B8A81003CA3141D2B09249A0" },
  { itemId: "165149821", color: "グリーン", variantId: "33d4c321-2157-4c91-8ea0-6cec48df1433", supplierSku: "CJNS325064805EV", externalSku: "TRC-33D4C32121574C918EA06CEC" },
  { itemId: null, color: "コーヒー", variantId: "c117d870-83fa-43c7-ba62-40b444d9952b", supplierSku: "CJNS325064806FU", externalSku: "TRC-C117D87083FA43C7BA6240B4" },
  { itemId: "165149831", color: "ブラック", variantId: "ba1b7089-c6ee-42f8-8682-6ef764cfdcc3", supplierSku: "CJNS325064803CX", externalSku: "TRC-BA1B7089C6EE42F886826EF7" },
  { itemId: "165149828", color: "ブルー", variantId: "2170283d-d650-4cef-8bf2-94e4ac1edde5", supplierSku: "CJNS325064804DW", externalSku: "TRC-2170283DD6504CEF8BF294E4" },
  { itemId: "165149835", color: "レッド", variantId: "fa7d6f54-881f-4720-93b8-a65887e16c2c", supplierSku: "CJNS325064802BY", externalSku: "TRC-FA7D6F54881F472093B8A658" },
] as const;

type BaseItem = Record<string, unknown>;
const asNumber = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const isVisible = (value: unknown) => value === true || value === 1 || value === "1";
const imageAt = (item: BaseItem, n: number) => {
  const value = item[`img${n}_origin`];
  return typeof value === "string" ? value.trim() : "";
};
const galleryCount = (item: BaseItem) =>
  Array.from({ length: 20 }, (_, i) => imageAt(item, i + 1)).filter(Boolean).length;
const variationsOf = (item: BaseItem) =>
  Array.isArray(item.variations) ? item.variations.filter((v): v is Record<string, unknown> =>
    Boolean(v && typeof v === "object" && !Array.isArray(v))) : [];

function matchesLegacyItem(item: BaseItem, target: typeof TARGETS[number]) {
  return String(item.item_id ?? "") === target.itemId
    && String(item.identifier ?? "") === target.externalSku
    && String(item.title ?? "") === BASE_ITEM_TITLE
    && asNumber(item.price) === PRICE
    && asNumber(item.stock) === COLOR_STOCK;
}

function variationsMatch(item: BaseItem) {
  const rows = variationsOf(item);
  if (rows.length !== TARGETS.length) return false;
  return TARGETS.every((target) => rows.some((row) =>
    String(row.variation ?? "") === target.color
    && String(row.variation_identifier ?? "") === target.externalSku
    && asNumber(row.variation_stock) === COLOR_STOCK
    && /^\d+$/.test(String(row.variation_id ?? ""))));
}

export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (!isBaseConfigured()) {
    return NextResponse.json({ ok: false, error: "base_oauth_not_configured" }, { status: 503 });
  }

  const db = createSupabaseAdminClient();
  try {
    const variantIds = TARGETS.map((target) => target.variantId);
    const { data: variants, error: variantError } = await db
      .from("commerce_variants")
      .select("id,product_id,sku,attributes")
      .in("id", variantIds);
    if (variantError || !variants || variants.length !== TARGETS.length) {
      return NextResponse.json({ ok: false, error: "TRACER_VARIANT_IDENTITY_READ_FAILED" }, { status: 500 });
    }
    const variantById = new Map(variants.map((row) => [String(row.id), row]));
    for (const target of TARGETS) {
      const row = variantById.get(target.variantId);
      const attributes = (row?.attributes ?? {}) as Record<string, unknown>;
      if (!row || String(row.product_id) !== PRODUCT_ID || String(row.sku) !== target.supplierSku
        || attributes.variantImageIdentityVerified !== true || attributes.colorImageVerified !== true
        || typeof attributes.variantImageUrl !== "string" || !attributes.variantImageUrl.startsWith("https://")) {
        return NextResponse.json({ ok: false, error: "TRACER_COLOR_VARIANT_OR_IMAGE_IDENTITY_MISMATCH", color: target.color }, { status: 409 });
      }
    }

    const { data: offers, error: offerError } = await db
      .from("supplier_offers")
      .select("variant_id,supplier_product_id,inventory,unit_cost,shipping_cost,ship_to")
      .in("variant_id", variantIds);
    if (offerError || !offers || offers.length !== TARGETS.length
      || offers.some((offer) => String(offer.supplier_product_id) !== "2610130254321621100"
        || Number(offer.inventory) < 1 || Number(offer.unit_cost) <= 0
        || Number(offer.shipping_cost) <= 0 || offer.ship_to !== "JP")) {
      return NextResponse.json({ ok: false, error: "CJ_SUPPLIER_OFFER_ELIGIBILITY_MISMATCH" }, { status: 409 });
    }

    const existingTargets = TARGETS.filter((target) => target.itemId !== null);
    const current = await Promise.all(existingTargets.map(async (target) => ({
      target,
      item: await getBaseItemDetail(target.itemId!),
    })));
    const parentAlreadyIntegrated = current.some(({ target, item }) =>
      target.itemId === PARENT_ID && variationsMatch(item));
    for (const { target, item } of current) {
      if (target.itemId === PARENT_ID && parentAlreadyIntegrated) continue;
      if (!matchesLegacyItem(item, target)) {
        return NextResponse.json({
          ok: false,
          error: "BASE_TARGET_IDENTITY_OR_STOCK_MISMATCH",
          itemId: target.itemId,
        }, { status: 409 });
      }
    }

    const itemById = new Map(current.map(({ target, item }) => [String(target.itemId), item]));
    const sourceImages = TARGETS.map((target) => {
      const variant = variantById.get(target.variantId)!;
      const attributes = (variant.attributes ?? {}) as Record<string, unknown>;
      const url = target.itemId
        ? imageAt(itemById.get(target.itemId)!, 1)
        : String(attributes.variantImageUrl ?? "");
      return { color: target.color, url };
    });
    if (sourceImages.some((entry) => !entry.url || !/^https:\/\//.test(entry.url))
      || new Set(sourceImages.map((entry) => entry.url)).size !== TARGETS.length) {
      return NextResponse.json({ ok: false, error: "BASE_COLOR_IMAGE_IDENTITY_INVALID" }, { status: 409 });
    }

    let parent = await getBaseItemDetail(PARENT_ID);
    if (galleryCount(parent) > TARGETS.length) {
      return NextResponse.json({ ok: false, error: "BASE_PARENT_GALLERY_HAS_UNEXPECTED_EXTRA_IMAGES" }, { status: 409 });
    }
    // BASE rehosts images; append by deterministic slot/count so a retry does not duplicate them.
    for (let index = 1; index < sourceImages.length; index += 1) {
      parent = await getBaseItemDetail(PARENT_ID);
      const currentCount = galleryCount(parent);
      const expectedCount = index + 1;
      if (currentCount >= expectedCount) continue;
      if (currentCount !== index) {
        return NextResponse.json({ ok: false, error: "BASE_PARENT_GALLERY_ORDER_UNEXPECTED" }, { status: 409 });
      }
      const freeSlot = Array.from({ length: 20 }, (_, i) => i + 1)
        .find((slot) => !imageAt(parent, slot));
      if (!freeSlot) {
        return NextResponse.json({ ok: false, error: "BASE_PARENT_IMAGE_SLOTS_EXHAUSTED" }, { status: 409 });
      }
      await addBaseItemImage({ itemId: PARENT_ID, imageNo: freeSlot, imageUrl: sourceImages[index].url });
      parent = await getBaseItemDetail(PARENT_ID);
      if (galleryCount(parent) !== expectedCount) {
        return NextResponse.json({ ok: false, error: "BASE_PARENT_IMAGE_ADD_READBACK_FAILED" }, { status: 502 });
      }
    }

    if (!variationsMatch(parent)) {
      if (variationsOf(parent).length !== 0) {
        return NextResponse.json({ ok: false, error: "BASE_PARENT_HAS_UNEXPECTED_VARIATIONS" }, { status: 409 });
      }
      await editBaseItem({
        itemId: PARENT_ID,
        title: PARENT_TITLE,
        price: PRICE,
        stock: COLOR_STOCK * TARGETS.length,
        visible: true,
        variations: TARGETS.map((target) => ({
          variationId: "",
          name: target.color,
          stock: COLOR_STOCK,
          identifier: target.externalSku,
        })),
      });
      parent = await getBaseItemDetail(PARENT_ID);
    }

    if (!variationsMatch(parent)
      || asNumber(parent.price) !== PRICE
      || asNumber(parent.stock) !== COLOR_STOCK * TARGETS.length
      || !isVisible(parent.visible)
      || String(parent.title ?? "") !== PARENT_TITLE) {
      return NextResponse.json({ ok: false, error: "BASE_PARENT_VARIATION_READBACK_FAILED" }, { status: 502 });
    }

    const variationRows = variationsOf(parent);
    const { data: listings, error: listingError } = await db
      .from("channel_listings")
      .select("id,variant_id,external_sku")
      .eq("channel", "base")
      .in("external_sku", TARGETS.map((target) => target.externalSku));
    if (listingError) {
      return NextResponse.json({ ok: false, error: "TRACER_BASE_LISTING_READ_FAILED" }, { status: 500 });
    }
    const listingBySku = new Map<string, Record<string, unknown>>();
    for (const row of listings ?? []) listingBySku.set(String(row.external_sku ?? ""), row);
    if (listingBySku.size !== (listings ?? []).length
      || TARGETS.filter((target) => target.itemId !== null).some((target) => !listingBySku.has(target.externalSku))
      || (listings ?? []).some((row) => !TARGETS.some((target) =>
        target.externalSku === String(row.external_sku) && target.variantId === String(row.variant_id)))) {
      return NextResponse.json({ ok: false, error: "TRACER_BASE_LISTING_IDENTITY_MISMATCH" }, { status: 409 });
    }

    const mappingResults = [];
    for (const target of TARGETS) {
      const variation = variationRows.find((row) =>
        String(row.variation ?? "") === target.color
        && String(row.variation_identifier ?? "") === target.externalSku);
      const variationId = String(variation?.variation_id ?? "");
      if (!/^\d+$/.test(variationId)) {
        return NextResponse.json({ ok: false, error: "BASE_VARIATION_ID_MISSING", color: target.color }, { status: 502 });
      }
      const listing = listingBySku.get(target.externalSku);
      const mapping = {
        external_product_id: PARENT_ID,
        external_variant_id: variationId,
        external_sku: target.externalSku,
        status: "published",
        selling_price: PRICE,
        published_url: `https://tracer.base.ec/items/${PARENT_ID}`,
      };
      let saved;
      let saveError;
      if (listing) {
        const result = await db.from("channel_listings").update(mapping)
          .eq("id", String(listing.id)).select("id").maybeSingle();
        saved = result.data;
        saveError = result.error;
      } else {
        const result = await db.from("channel_listings").insert({
          ...mapping,
          variant_id: target.variantId,
          channel: "base",
        }).select("id").maybeSingle();
        saved = result.data;
        saveError = result.error;
      }
      if (saveError || !saved) {
        return NextResponse.json({ ok: false, error: "TRACER_BASE_VARIANT_MAPPING_UPDATE_FAILED", color: target.color }, { status: 500 });
      }
      mappingResults.push({ color: target.color, variationId, listingId: String(saved.id) });
    }

    const hiddenLegacyIds = [];
    for (const target of existingTargets.filter((entry) => entry.itemId !== PARENT_ID)) {
      const item = await getBaseItemDetail(target.itemId!);
      if (isVisible(item.visible)) await editBaseItem({ itemId: target.itemId!, visible: false });
      const verified = await getBaseItemDetail(target.itemId!);
      if (isVisible(verified.visible)) {
        return NextResponse.json({ ok: false, error: "BASE_LEGACY_HIDE_READBACK_FAILED", itemId: target.itemId }, { status: 502 });
      }
      hiddenLegacyIds.push(target.itemId);
    }

    const finalParent = await getBaseItemDetail(PARENT_ID);
    const finalVariations = variationsOf(finalParent);
    const finalOk = variationsMatch(finalParent)
      && asNumber(finalParent.stock) === 60
      && asNumber(finalParent.price) === PRICE
      && isVisible(finalParent.visible)
      && String(finalParent.title ?? "") === PARENT_TITLE
      && galleryCount(finalParent) === TARGETS.length
      && TARGETS.every((target) => finalVariations.some((row) =>
        String(row.variation ?? "") === target.color
        && String(row.variation_identifier ?? "") === target.externalSku
        && asNumber(row.variation_stock) === COLOR_STOCK));
    if (!finalOk) {
      return NextResponse.json({ ok: false, error: "BASE_FINAL_READBACK_FAILED", mappings: mappingResults }, { status: 502 });
    }

    const { data: finalListings, error: finalListingError } = await db
      .from("channel_listings")
      .select("variant_id,external_product_id,external_variant_id,external_sku,status,selling_price,published_url")
      .eq("channel", "base")
      .in("external_sku", TARGETS.map((target) => target.externalSku));
    if (finalListingError || !finalListings || finalListings.length !== TARGETS.length
      || TARGETS.some((target) => !finalListings.some((row) =>
        String(row.variant_id) === target.variantId
        && String(row.external_product_id) === PARENT_ID
        && String(row.external_variant_id) === mappingResults.find((entry) => entry.color === target.color)?.variationId
        && String(row.external_sku) === target.externalSku
        && row.status === "published"
        && Number(row.selling_price) === PRICE
        && String(row.published_url) === `https://tracer.base.ec/items/${PARENT_ID}`))) {
      return NextResponse.json({ ok: false, error: "TRACER_FINAL_MAPPING_READBACK_FAILED" }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      writesPerformed: true,
      parentItemId: PARENT_ID,
      parentTitle: PARENT_TITLE,
      price: PRICE,
      totalStock: 60,
      variations: mappingResults,
      galleryImageCount: galleryCount(finalParent),
      hiddenLegacyIds,
      finalReadbackVerified: true,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    console.error("[BASE LARGE CAPACITY SIX COLOR CONSOLIDATION] failed", cause instanceof Error ? cause.message : "unknown");
    return NextResponse.json({ ok: false, error: "BASE_LARGE_CAPACITY_SIX_COLOR_CONSOLIDATION_FAILED" }, { status: 500 });
  }
}
