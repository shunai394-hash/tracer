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

const PRODUCT_ID = "78440a5e-c95e-4282-bf39-f7885f66dc0f";
const PARENT_ID = "165059397";
const PARENT_TITLE = "アニマル柄・メタルパーツ付き レディースハンドバッグ";
const PRICE = 11546;
const COLOR_STOCK = 10;
const TARGETS = [
  { itemId: "165059397", baseTitle: PARENT_TITLE, color: "ゼブラ柄", variantId: "ae270a8c-c0cb-4275-a767-8f53e69e634f", supplierSku: "CJNS310228901AZ", externalSku: "TRC-AE270A8CC0CB4275A7678F53" },
  { itemId: "165059392", baseTitle: PARENT_TITLE, color: "クロコ柄", variantId: "2722178e-120f-43e8-a219-e3da7b1b32a6", supplierSku: "CJNS310228902BY", externalSku: "TRC-2722178E120F43E8A219E3DA" },
  { itemId: "165059376", baseTitle: `${PARENT_TITLE}（ブラック・グレー）`, color: "グレーブラックマット", variantId: "44012552-de1c-4e6e-9a46-1f42bf308a85", supplierSku: "CJNS310228905EV", externalSku: "TRC-44012552DE1C4E6E9A461F42" },
  { itemId: "165059387", baseTitle: `${PARENT_TITLE}（ブラック）`, color: "ブラックタビー", variantId: "f3152e19-7d52-4c37-810e-3e6741c98781", supplierSku: "CJNS310228903CX", externalSku: "TRC-F3152E197D524C37810E3E67" },
  { itemId: "165059382", baseTitle: `${PARENT_TITLE}（ブルー）`, color: "ブルーマット", variantId: "20ea992b-2a82-4953-aea9-685027cc7406", supplierSku: "CJNS310228904DW", externalSku: "TRC-20EA992B2A824953AEA96850" },
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
    && String(item.title ?? "") === target.baseTitle
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
        || attributes.variantImageIdentityVerified !== true
        || typeof attributes.variantImageUrl !== "string" || !attributes.variantImageUrl.startsWith("https://")) {
        return NextResponse.json({ ok: false, error: "TRACER_VARIANT_IMAGE_IDENTITY_MISMATCH", color: target.color }, { status: 409 });
      }
    }

    const { data: offers, error: offerError } = await db
      .from("supplier_offers")
      .select("variant_id,supplier_product_id,inventory,unit_cost,shipping_cost,ship_to")
      .in("variant_id", variantIds);
    if (offerError || !offers || offers.length !== TARGETS.length
      || offers.some((offer) => String(offer.supplier_product_id) !== "2608270931501632200"
        || Number(offer.inventory) < 1 || Number(offer.unit_cost) <= 0
        || Number(offer.shipping_cost) <= 0 || offer.ship_to !== "JP")) {
      return NextResponse.json({ ok: false, error: "CJ_SUPPLIER_OFFER_ELIGIBILITY_MISMATCH" }, { status: 409 });
    }

    const current = await Promise.all(TARGETS.map(async (target) => ({
      target,
      item: await getBaseItemDetail(target.itemId),
    })));
    const parentAlreadyIntegrated = current.some(({ target, item }) =>
      target.itemId === PARENT_ID && variationsMatch(item));
    for (const { target, item } of current) {
      if (target.itemId === PARENT_ID && parentAlreadyIntegrated) continue;
      if (!matchesLegacyItem(item, target)) {
        return NextResponse.json({ ok: false, error: "BASE_TARGET_IDENTITY_OR_STOCK_MISMATCH", itemId: target.itemId }, { status: 409 });
      }
    }

    const sourceImages = current.map(({ target, item }) => ({ color: target.color, url: imageAt(item, 1) }));
    if (sourceImages.some((entry) => !entry.url || !entry.url.startsWith("https://base-ec2.akamaized.net/"))
      || new Set(sourceImages.map((entry) => entry.url)).size !== TARGETS.length) {
      return NextResponse.json({ ok: false, error: "BASE_COLOR_IMAGE_IDENTITY_INVALID" }, { status: 409 });
    }

    let parent = await getBaseItemDetail(PARENT_ID);
    if (galleryCount(parent) > TARGETS.length) {
      return NextResponse.json({ ok: false, error: "BASE_PARENT_GALLERY_HAS_UNEXPECTED_EXTRA_IMAGES" }, { status: 409 });
    }
    // BASE rehosts uploaded images; append by deterministic slot/count so retries do not duplicate images.
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
    if (listingError || !listings || listings.length !== TARGETS.length) {
      return NextResponse.json({ ok: false, error: "TRACER_BASE_LISTING_READ_FAILED" }, { status: 500 });
    }
    const listingBySku = new Map<string, Record<string, unknown>>();
    for (const row of listings) listingBySku.set(String(row.external_sku ?? ""), row);
    if (listingBySku.size !== TARGETS.length
      || TARGETS.some((target) => !listingBySku.has(target.externalSku))
      || listings.some((row) => !TARGETS.some((target) =>
        target.externalSku === String(row.external_sku) && target.variantId === String(row.variant_id)))) {
      return NextResponse.json({ ok: false, error: "TRACER_BASE_LISTING_IDENTITY_MISMATCH" }, { status: 409 });
    }

    const mappingResults: Array<{ color: string; variationId: string; listingId: string }> = [];
    for (const target of TARGETS) {
      const variation = variationRows.find((row) =>
        String(row.variation ?? "") === target.color
        && String(row.variation_identifier ?? "") === target.externalSku);
      const variationId = String(variation?.variation_id ?? "");
      const listing = listingBySku.get(target.externalSku)!;
      if (!/^\d+$/.test(variationId)) {
        return NextResponse.json({ ok: false, error: "BASE_VARIATION_ID_MISSING", color: target.color }, { status: 502 });
      }
      const { data, error } = await db.from("channel_listings")
        .update({
          external_product_id: PARENT_ID,
          external_variant_id: variationId,
          external_sku: target.externalSku,
          status: "published",
          selling_price: PRICE,
          published_url: `https://tracer.base.ec/items/${PARENT_ID}`,
        })
        .eq("id", String(listing.id))
        .select("id")
        .maybeSingle();
      if (error || !data) {
        return NextResponse.json({ ok: false, error: "TRACER_BASE_VARIANT_MAPPING_UPDATE_FAILED", color: target.color }, { status: 500 });
      }
      mappingResults.push({ color: target.color, variationId, listingId: String(data.id) });
    }

    const hiddenLegacyIds = [];
    for (const target of TARGETS.filter((entry) => entry.itemId !== PARENT_ID)) {
      const item = await getBaseItemDetail(target.itemId);
      if (isVisible(item.visible)) await editBaseItem({ itemId: target.itemId, visible: false });
      const verified = await getBaseItemDetail(target.itemId);
      if (isVisible(verified.visible)) {
        return NextResponse.json({ ok: false, error: "BASE_LEGACY_HIDE_READBACK_FAILED", itemId: target.itemId }, { status: 502 });
      }
      hiddenLegacyIds.push(target.itemId);
    }

    const finalParent = await getBaseItemDetail(PARENT_ID);
    const finalVariations = variationsOf(finalParent);
    const finalOk = variationsMatch(finalParent)
      && asNumber(finalParent.stock) === 50
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
      totalStock: 50,
      variations: mappingResults,
      galleryImageCount: galleryCount(finalParent),
      hiddenLegacyIds,
      finalReadbackVerified: true,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    console.error("[BASE ANIMAL HANDBAG FIVE COLOR CONSOLIDATION] failed", cause instanceof Error ? cause.message : "unknown");
    return NextResponse.json({ ok: false, error: "BASE_ANIMAL_HANDBAG_FIVE_COLOR_CONSOLIDATION_FAILED" }, { status: 500 });
  }
}
