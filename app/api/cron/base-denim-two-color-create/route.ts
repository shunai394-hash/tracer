import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import {
  addBaseItemImage,
  createBaseItem,
  editBaseItem,
  getBaseItemDetail,
  isBaseConfigured,
} from "@/lib/channels/base";

export const runtime = "nodejs";
export const maxDuration = 180;

const PRODUCT_ID = "73436e12-795d-4374-9863-0b94391c572e";
const SUPPLIER_PRODUCT_ID = "1670333800435421184";
const PARENT_TITLE = "デニム素材・アンダーアーム レディースショルダーバッグ";
const PARENT_IDENTIFIER = "TRC-DENIM-1670333800435421184";
const PRICE = 3859;
const COLOR_STOCK = 10;
const TOTAL_STOCK = 20;
const PARENT_URL_PREFIX = "https://tracer.base.ec/items/";
const VARIANTS = [
  {
    variantId: "3b28034b-69f9-4659-ab73-d590cbca3950",
    supplierVariantId: "1670333800619970560",
    supplierSku: "CJNS178139901AZ",
    externalSku: "TRC-3B28034B69F94659AB73D590",
    color: "ブラック",
    imageUrl: "https://cdn.shopify.com/s/files/1/0746/2443/4220/files/d3d1ae9c-e617-437b-9f08-e4329ca1abc4.jpg?v=1794207822",
  },
  {
    variantId: "5e7634aa-63e8-49f9-a0d7-ef28447ebb0e",
    supplierVariantId: "1670333800691273728",
    supplierSku: "CJNS178139902BY",
    externalSku: "TRC-5E7634AA63E849F9A0D7EF28",
    color: "ブルー",
    imageUrl: "https://cdn.shopify.com/s/files/1/0746/2443/4220/files/0a58679f-c389-4a14-bf7d-cdbc1e914041.jpg?v=1794207822",
  },
] as const;

type BaseItem = Record<string, unknown>;
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
function variationsMatch(item: BaseItem) {
  const rows = variationsOf(item);
  if (rows.length !== VARIANTS.length) return false;
  return VARIANTS.every((variant) => rows.some((row) =>
    String(row.variation ?? "") === variant.color
    && String(row.variation_identifier ?? "") === variant.externalSku
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
  const nowIso = new Date().toISOString();
  try {
    const { data: product, error: productError } = await db.from("commerce_products")
      .select("id,source_key,title_ja,description_ja,metadata")
      .eq("id", PRODUCT_ID).maybeSingle();
    if (productError || !product || product.source_key !== "cj:" + SUPPLIER_PRODUCT_ID) {
      return NextResponse.json({ ok: false, error: "DENIM_BASE_PRODUCT_IDENTITY_MISMATCH" }, { status: 409 });
    }

    const { data: variants, error: variantError } = await db.from("commerce_variants")
      .select("id,product_id,source_variant_key,sku,attributes")
      .in("id", VARIANTS.map((variant) => variant.variantId));
    if (variantError || !variants || variants.length !== VARIANTS.length) {
      return NextResponse.json({ ok: false, error: "DENIM_BASE_VARIANT_READ_FAILED" }, { status: 500 });
    }
    const variantById = new Map(variants.map((row) => [String(row.id), row]));
    for (const variant of VARIANTS) {
      const row = variantById.get(variant.variantId);
      const attributes = asRecord(row?.attributes);
      if (!row || String(row.product_id) !== PRODUCT_ID || String(row.sku) !== variant.supplierSku
        || String(row.source_variant_key) !== variant.supplierVariantId
        || attributes.variantImageIdentityVerified !== true || attributes.colorImageVerified !== true
        || !String(attributes.variantImageUrl ?? "").includes(variant.imageUrl.includes("d3d1ae9c") ? "d3d1ae9c" : "0a58679f")) {
        return NextResponse.json({ ok: false, error: "DENIM_BASE_VARIANT_IMAGE_IDENTITY_MISMATCH", color: variant.color }, { status: 409 });
      }
    }

    const { data: offers, error: offerError } = await db.from("supplier_offers")
      .select("variant_id,supplier_product_id,supplier_variant_id,inventory,unit_cost,shipping_cost,ship_to,source_status,last_checked_at")
      .eq("supplier_code", "cj").in("variant_id", VARIANTS.map((variant) => variant.variantId));
    if (offerError || !offers || offers.length !== VARIANTS.length
      || offers.some((offer) => String(offer.supplier_product_id) !== SUPPLIER_PRODUCT_ID
        || offer.ship_to !== "JP" || offer.source_status !== "verified"
        || Number(offer.inventory) < 1 || Number(offer.unit_cost) <= 0 || Number(offer.shipping_cost) <= 0)) {
      return NextResponse.json({ ok: false, error: "DENIM_BASE_SUPPLIER_GATE_FAILED" }, { status: 409 });
    }
    const checkedAt = Math.min(...offers.map((offer) => Date.parse(String(offer.last_checked_at ?? ""))));
    if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > 24 * 60 * 60 * 1000) {
      return NextResponse.json({ ok: false, error: "DENIM_BASE_SUPPLIER_EVIDENCE_STALE" }, { status: 409 });
    }

    const { data: prices, error: priceError } = await db.from("commerce_prices")
      .select("variant_id,selling_price,margin_rate")
      .in("variant_id", VARIANTS.map((variant) => variant.variantId));
    if (priceError || !prices || prices.length !== VARIANTS.length
      || prices.some((price) => Number(price.selling_price) !== PRICE || Number(price.margin_rate) < 0.5)) {
      return NextResponse.json({ ok: false, error: "DENIM_BASE_PRICE_OR_MARGIN_GATE_FAILED" }, { status: 409 });
    }

    const { data: existingListings, error: listingReadError } = await db.from("channel_listings")
      .select("id,variant_id,external_product_id,external_variant_id,external_sku,status")
      .eq("channel", "base")
      .in("variant_id", VARIANTS.map((variant) => variant.variantId));
    if (listingReadError) {
      return NextResponse.json({ ok: false, error: "DENIM_BASE_LISTING_READ_FAILED" }, { status: 500 });
    }
    if ((existingListings ?? []).some((row) => !VARIANTS.some((variant) => variant.variantId === String(row.variant_id)))) {
      return NextResponse.json({ ok: false, error: "DENIM_BASE_LISTING_VARIANT_MISMATCH" }, { status: 409 });
    }

    const metadata = asRecord(product.metadata);
    const familyMetadata = asRecord(metadata.baseColorFamily);
    const mappedParentIds = [...new Set((existingListings ?? []).map((row) => String(row.external_product_id ?? "")).filter(Boolean))];
    if (mappedParentIds.length > 1) {
      return NextResponse.json({ ok: false, error: "DENIM_BASE_EXISTING_PARENT_CONFLICT" }, { status: 409 });
    }
    let parentId = String(familyMetadata.parentItemId ?? mappedParentIds[0] ?? "").trim();
    if (!parentId) {
      const created = await createBaseItem({
        title: PARENT_TITLE,
        identifier: PARENT_IDENTIFIER,
        detail: String(product.description_ja ?? "").trim() || "デニム素材のレディースショルダーバッグです。カラーを選択してお選びいただけます。",
        price: PRICE,
        stock: TOTAL_STOCK,
        visible: false,
      });
      const returned = created.item?.item_id ?? created.item_id;
      parentId = String(returned ?? "").trim();
      if (!/^\d+$/.test(parentId)) {
        return NextResponse.json({ ok: false, error: "DENIM_BASE_CREATE_RESPONSE_MISSING_ITEM_ID" }, { status: 502 });
      }
      const { error: metadataError } = await db.from("commerce_products").update({
        metadata: {
          ...metadata,
          baseColorFamily: {
            ...familyMetadata,
            parentItemId: parentId,
            supplierProductId: SUPPLIER_PRODUCT_ID,
            handle: "denim-two-color",
            state: "creating",
            updatedAt: nowIso,
          },
        },
        updated_at: nowIso,
      }).eq("id", PRODUCT_ID);
      if (metadataError) {
        return NextResponse.json({ ok: false, error: "DENIM_BASE_PARENT_ID_PERSIST_FAILED", parentItemId: parentId }, { status: 500 });
      }
    }

    let parent = await getBaseItemDetail(parentId);
    if (String(parent.item_id ?? "") !== parentId) {
      return NextResponse.json({ ok: false, error: "DENIM_BASE_PARENT_READBACK_ID_MISMATCH" }, { status: 502 });
    }
    if (String(parent.title ?? "") !== PARENT_TITLE && variationsOf(parent).length === 0) {
      await editBaseItem({ itemId: parentId, title: PARENT_TITLE, price: PRICE, stock: TOTAL_STOCK, visible: false });
      parent = await getBaseItemDetail(parentId);
    }
    if (galleryCount(parent) > VARIANTS.length) {
      return NextResponse.json({ ok: false, error: "DENIM_BASE_PARENT_HAS_EXTRA_IMAGES" }, { status: 409 });
    }
    for (let index = 0; index < VARIANTS.length; index += 1) {
      parent = await getBaseItemDetail(parentId);
      const currentCount = galleryCount(parent);
      const expectedCount = index + 1;
      if (currentCount >= expectedCount) continue;
      if (currentCount !== index) {
        return NextResponse.json({ ok: false, error: "DENIM_BASE_GALLERY_ORDER_UNEXPECTED" }, { status: 409 });
      }
      const freeSlot = Array.from({ length: 20 }, (_, i) => i + 1).find((slot) => !imageAt(parent, slot));
      if (!freeSlot) return NextResponse.json({ ok: false, error: "DENIM_BASE_IMAGE_SLOTS_EXHAUSTED" }, { status: 409 });
      await addBaseItemImage({ itemId: parentId, imageNo: freeSlot, imageUrl: VARIANTS[index].imageUrl });
      parent = await getBaseItemDetail(parentId);
      if (galleryCount(parent) !== expectedCount) {
        return NextResponse.json({ ok: false, error: "DENIM_BASE_IMAGE_ADD_READBACK_FAILED", parentItemId: parentId }, { status: 502 });
      }
    }

    if (!variationsMatch(parent)) {
      if (variationsOf(parent).length !== 0) {
        return NextResponse.json({ ok: false, error: "DENIM_BASE_PARENT_HAS_UNEXPECTED_VARIATIONS", parentItemId: parentId }, { status: 409 });
      }
      await editBaseItem({
        itemId: parentId,
        title: PARENT_TITLE,
        price: PRICE,
        stock: TOTAL_STOCK,
        visible: true,
        variations: VARIANTS.map((variant) => ({
          variationId: "",
          name: variant.color,
          stock: COLOR_STOCK,
          identifier: variant.externalSku,
        })),
      });
      parent = await getBaseItemDetail(parentId);
    } else if (!isVisible(parent.visible)) {
      await editBaseItem({ itemId: parentId, visible: true });
      parent = await getBaseItemDetail(parentId);
    }

    if (!variationsMatch(parent) || asNumber(parent.price) !== PRICE
      || asNumber(parent.stock) !== TOTAL_STOCK || !isVisible(parent.visible)
      || String(parent.title ?? "") !== PARENT_TITLE || galleryCount(parent) !== VARIANTS.length) {
      return NextResponse.json({ ok: false, error: "DENIM_BASE_PARENT_FINAL_READBACK_FAILED", parentItemId: parentId }, { status: 502 });
    }

    const variationRows = variationsOf(parent);
    const parentUrl = PARENT_URL_PREFIX + parentId;
    const mappingResults = [];
    for (const variant of VARIANTS) {
      const baseVariation = variationRows.find((row) =>
        String(row.variation ?? "") === variant.color
        && String(row.variation_identifier ?? "") === variant.externalSku);
      const variationId = String(baseVariation?.variation_id ?? "");
      if (!/^\d+$/.test(variationId)) {
        return NextResponse.json({ ok: false, error: "DENIM_BASE_VARIATION_ID_MISSING", color: variant.color }, { status: 502 });
      }
      const existing = (existingListings ?? []).find((row) => String(row.variant_id) === variant.variantId);
      const mapping = {
        external_product_id: parentId,
        external_variant_id: variationId,
        external_sku: variant.externalSku,
        status: "published",
        selling_price: PRICE,
        published_url: parentUrl,
        last_error: null,
        last_synced_at: nowIso,
        updated_at: nowIso,
      };
      let savedId = "";
      if (existing) {
        const { data, error } = await db.from("channel_listings").update(mapping)
          .eq("id", String(existing.id)).select("id").maybeSingle();
        if (error || !data) {
          return NextResponse.json({ ok: false, error: "DENIM_BASE_LISTING_UPDATE_FAILED", color: variant.color }, { status: 500 });
        }
        savedId = String(data.id);
      } else {
        const { data, error } = await db.from("channel_listings").insert({
          ...mapping,
          channel: "base",
          variant_id: variant.variantId,
        }).select("id").maybeSingle();
        if (error || !data) {
          return NextResponse.json({ ok: false, error: "DENIM_BASE_LISTING_INSERT_FAILED", color: variant.color }, { status: 500 });
        }
        savedId = String(data.id);
      }
      mappingResults.push({ color: variant.color, variationId, listingId: savedId });
    }

    const { data: finalListings, error: finalError } = await db.from("channel_listings")
      .select("variant_id,external_product_id,external_variant_id,external_sku,status,selling_price,published_url")
      .eq("channel", "base")
      .in("variant_id", VARIANTS.map((variant) => variant.variantId));
    if (finalError || !finalListings || finalListings.length !== VARIANTS.length
      || VARIANTS.some((variant) => !finalListings.some((row) =>
        String(row.variant_id) === variant.variantId
        && String(row.external_product_id) === parentId
        && String(row.external_variant_id) === mappingResults.find((item) => item.color === variant.color)?.variationId
        && String(row.external_sku) === variant.externalSku
        && row.status === "published"
        && Number(row.selling_price) === PRICE
        && String(row.published_url) === parentUrl))) {
      return NextResponse.json({ ok: false, error: "DENIM_BASE_FINAL_MAPPING_READBACK_FAILED", parentItemId: parentId }, { status: 502 });
    }

    const nextMetadata = {
      ...metadata,
      baseColorFamily: {
        ...familyMetadata,
        parentItemId: parentId,
        supplierProductId: SUPPLIER_PRODUCT_ID,
        state: "published",
        variantCount: VARIANTS.length,
        updatedAt: nowIso,
      },
    };
    const { error: finalMetadataError } = await db.from("commerce_products")
      .update({ metadata: nextMetadata, updated_at: nowIso })
      .eq("id", PRODUCT_ID);
    if (finalMetadataError) {
      return NextResponse.json({ ok: false, error: "DENIM_BASE_FINAL_METADATA_UPDATE_FAILED", parentItemId: parentId }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      writesPerformed: true,
      parentItemId: parentId,
      parentTitle: PARENT_TITLE,
      price: PRICE,
      totalStock: TOTAL_STOCK,
      galleryImageCount: galleryCount(parent),
      variations: mappingResults,
      publishedUrl: parentUrl,
      finalReadbackVerified: true,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[BASE DENIM TWO-COLOR CREATE] failed", message);
    return NextResponse.json({ ok: false, error: message.slice(0, 240) }, { status: 502 });
  }
}
