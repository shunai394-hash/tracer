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

const PARENT_ID = "163167419";
const TARGETS = [
  { itemId: "163167419", color: "ブルー", sku: "TRC-58626F4A07F94DA69ECAEC41" },
  { itemId: "163159546", color: "グリーン", sku: "TRC-C517D49F4DF14EDBB9631A31" },
  { itemId: "163159545", color: "ピンク", sku: "TRC-83E2FEDAE73A4991820CA094" },
  { itemId: "163159542", color: "ブラック", sku: "TRC-7F31F0645C7F4B5CAB9C1DD8" },
  { itemId: "163159540", color: "ブラウン", sku: "TRC-E4CD9C3FFF824FC98ACF436C" },
] as const;
const PRICE = 7796;
const COLOR_STOCK = 10;
const PARENT_TITLE = "ペーパー素材の編み込みハンドバッグ";

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
const variationsOf = (item: BaseItem) =>
  Array.isArray(item.variations) ? item.variations.filter((v): v is Record<string, unknown> =>
    Boolean(v && typeof v === "object" && !Array.isArray(v))) : [];

function matchesTarget(item: BaseItem, target: typeof TARGETS[number]) {
  return String(item.item_id ?? "") === target.itemId
    && String(item.identifier ?? "") === target.sku
    && String(item.title ?? "") === `${PARENT_TITLE}（${target.color}）`
    && asNumber(item.price) === PRICE
    && asNumber(item.stock) === COLOR_STOCK;
}

function variationsMatch(item: BaseItem) {
  const rows = variationsOf(item);
  if (rows.length !== TARGETS.length) return false;
  return TARGETS.every((target) => rows.some((row) =>
    String(row.variation ?? "") === target.color
    && String(row.variation_identifier ?? "") === target.sku
    && asNumber(row.variation_stock) === COLOR_STOCK
    && /^\d+$/.test(String(row.variation_id ?? ""))));
}

export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (!isBaseConfigured()) {
    return NextResponse.json({ ok: false, error: "base_oauth_not_configured" }, { status: 503 });
  }

  try {
    const current = await Promise.all(TARGETS.map(async (target) => ({
      target,
      item: await getBaseItemDetail(target.itemId),
    })));

    for (const { target, item } of current) {
      if (target.itemId === PARENT_ID && variationsMatch(item)) continue;
      if (!matchesTarget(item, target)) {
        return NextResponse.json({
          ok: false,
          error: "BASE_TARGET_IDENTITY_OR_STOCK_MISMATCH",
          itemId: target.itemId,
        }, { status: 409 });
      }
    }

    const sourceImages = current.map(({ target, item }) => ({
      color: target.color,
      url: imageAt(item, 1),
    }));
    if (sourceImages.some((entry) => !entry.url || !/^https:\/\/base-ec2\.akamaized\.net\//.test(entry.url))
      || new Set(sourceImages.map((entry) => entry.url)).size !== TARGETS.length) {
      return NextResponse.json({ ok: false, error: "BASE_COLOR_IMAGE_IDENTITY_INVALID" }, { status: 409 });
    }

    let parent = await getBaseItemDetail(PARENT_ID);
    for (const source of sourceImages) {
      const present = Array.from({ length: 20 }, (_, i) => imageAt(parent, i + 1)).includes(source.url);
      if (present) continue;
      const freeSlot = Array.from({ length: 20 }, (_, i) => i + 1)
        .find((slot) => !imageAt(parent, slot));
      if (!freeSlot) {
        return NextResponse.json({ ok: false, error: "BASE_PARENT_IMAGE_SLOTS_EXHAUSTED" }, { status: 409 });
      }
      await addBaseItemImage({ itemId: PARENT_ID, imageNo: freeSlot, imageUrl: source.url });
      parent = await getBaseItemDetail(PARENT_ID);
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
          identifier: target.sku,
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
    const listingBySku = new Map<string, Record<string, unknown>>();
    const db = createSupabaseAdminClient();
    const { data: listings, error: listingError } = await db
      .from("channel_listings")
      .select("id,variant_id,external_product_id,external_variant_id,external_sku,selling_price,status")
      .eq("channel", "base")
      .in("external_sku", TARGETS.map((target) => target.sku));
    if (listingError) {
      return NextResponse.json({ ok: false, error: "TRACER_BASE_LISTING_READ_FAILED" }, { status: 500 });
    }
    for (const row of listings ?? []) listingBySku.set(String(row.external_sku ?? ""), row);
    if (listingBySku.size !== TARGETS.length || TARGETS.some((target) => !listingBySku.has(target.sku))) {
      return NextResponse.json({ ok: false, error: "TRACER_BASE_LISTING_IDENTITY_INCOMPLETE" }, { status: 409 });
    }

    const mappingResults = [];
    for (const target of TARGETS) {
      const variation = variationRows.find((row) =>
        String(row.variation ?? "") === target.color
        && String(row.variation_identifier ?? "") === target.sku);
      const variationId = String(variation?.variation_id ?? "");
      const listing = listingBySku.get(target.sku)!;
      if (!/^\d+$/.test(variationId)) {
        return NextResponse.json({ ok: false, error: "BASE_VARIATION_ID_MISSING", color: target.color }, { status: 502 });
      }
      const { data, error } = await db.from("channel_listings")
        .update({
          external_product_id: PARENT_ID,
          external_variant_id: variationId,
          status: "published",
          selling_price: PRICE,
        })
        .eq("id", String(listing.id))
        .select("id")
        .maybeSingle();
      if (error || !data) {
        return NextResponse.json({
          ok: false,
          error: "TRACER_BASE_VARIANT_MAPPING_UPDATE_FAILED",
          color: target.color,
        }, { status: 500 });
      }
      mappingResults.push({ color: target.color, variationId, listingId: String(listing.id) });
    }

    const hiddenLegacyIds = [];
    for (const target of TARGETS.filter((entry) => entry.itemId !== PARENT_ID)) {
      const item = await getBaseItemDetail(target.itemId);
      if (isVisible(item.visible)) {
        await editBaseItem({ itemId: target.itemId, visible: false });
      }
      const verified = await getBaseItemDetail(target.itemId);
      if (isVisible(verified.visible)) {
        return NextResponse.json({
          ok: false,
          error: "BASE_LEGACY_HIDE_READBACK_FAILED",
          itemId: target.itemId,
          parentItemId: PARENT_ID,
          mappings: mappingResults,
        }, { status: 502 });
      }
      hiddenLegacyIds.push(target.itemId);
    }

    const finalParent = await getBaseItemDetail(PARENT_ID);
    const finalVariations = variationsOf(finalParent);
    const finalImages = Array.from({ length: 20 }, (_, i) => imageAt(finalParent, i + 1)).filter(Boolean);
    const finalOk = variationsMatch(finalParent)
      && asNumber(finalParent.stock) === 50
      && asNumber(finalParent.price) === PRICE
      && isVisible(finalParent.visible)
      && TARGETS.every((target) => finalVariations.some((row) =>
        String(row.variation ?? "") === target.color
        && String(row.variation_identifier ?? "") === target.sku
        && asNumber(row.variation_stock) === COLOR_STOCK))
      && sourceImages.every((source) => finalImages.includes(source.url));
    if (!finalOk) {
      return NextResponse.json({ ok: false, error: "BASE_FINAL_READBACK_FAILED", mappings: mappingResults }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      writesPerformed: true,
      parentItemId: PARENT_ID,
      parentTitle: PARENT_TITLE,
      price: PRICE,
      totalStock: 50,
      variations: mappingResults,
      galleryImageCount: finalImages.length,
      hiddenLegacyIds,
      finalReadbackVerified: true,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    console.error("[BASE FIVE COLOR CONSOLIDATION] failed", cause instanceof Error ? cause.message : "unknown");
    return NextResponse.json({ ok: false, error: "BASE_FIVE_COLOR_CONSOLIDATION_FAILED" }, { status: 500 });
  }
}
