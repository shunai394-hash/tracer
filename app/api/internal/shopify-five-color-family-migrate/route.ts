import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import {
  activateShopifyProduct,
  createShopifyColorFamily,
  ensureShopifyProductPublished,
  readShopifyVariantInventorySnapshot,
  unpublishShopifyProduct,
} from "@/lib/shopify/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

// Exact supplier-native family and exact legacy Shopify product/variant identities.
// This route intentionally does not accept caller-supplied IDs.
const SUPPLIER_PRODUCT_ID = "2606090341151608200";
const HANDLE = "paper-rope-woven-handbag-2606090341151608200";
const FAMILY = [
  { vid: "2606090341151608900", sku: "CJNS292694701AZ", colorLabel: "ブルー", oldProductId: "gid://shopify/Product/8621474611244", oldVariantId: "gid://shopify/ProductVariant/46410544349228" },
  { vid: "2606090341151609400", sku: "CJNS292694702BY", colorLabel: "グリーン", oldProductId: "gid://shopify/Product/8621385416748", oldVariantId: "gid://shopify/ProductVariant/46410294525996" },
  { vid: "2606090341151609900", sku: "CJNS292694703CX", colorLabel: "ピンク", oldProductId: "gid://shopify/Product/8621385383980", oldVariantId: "gid://shopify/ProductVariant/46410294493228" },
  { vid: "2606090341161600400", sku: "CJNS292694704DW", colorLabel: "ブラック", oldProductId: "gid://shopify/Product/8621385351212", oldVariantId: "gid://shopify/ProductVariant/46410294427692" },
  { vid: "2606090341161600800", sku: "CJNS292694705EV", colorLabel: "ブラウン", oldProductId: "gid://shopify/Product/8621385285676", oldVariantId: "gid://shopify/ProductVariant/46410294362156" },
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeDescriptionHtml(value: string): string {
  const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return "<p>" + escaped.replace(/\r?\n/g, "<br>") + "</p>";
}

function validHttpsImage(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)cjdropshipping\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  const now = new Date();
  const nowIso = now.toISOString();
  const expectedByVid = new Map<string, (typeof FAMILY)[number]>(FAMILY.map((item) => [item.vid, item]));

  try {
    const { data: product, error: productError } = await db.from("commerce_products")
      .select("id,source_key,title_ja,description_ja")
      .eq("source_key", "cj:" + SUPPLIER_PRODUCT_ID)
      .maybeSingle();
    if (productError || !product) throw new Error("color_family_product_read_failed:" + (productError?.message ?? "missing"));
    if (product.source_key !== "cj:" + SUPPLIER_PRODUCT_ID) throw new Error("color_family_parent_identity_mismatch");

    const { data: variants, error: variantsError } = await db.from("commerce_variants")
      .select("id,product_id,source_variant_key,sku,title_ja,attributes")
      .eq("product_id", product.id);
    if (variantsError) throw new Error("color_family_variants_read_failed:" + variantsError.message);
    if (!variants || variants.length !== FAMILY.length) throw new Error("color_family_variant_count_mismatch");

    const variantIds = variants.map((row) => String(row.id));
    const [{ data: offers, error: offersError }, { data: prices, error: pricesError }, { data: channelRows, error: channelError }] = await Promise.all([
      db.from("supplier_offers")
        .select("variant_id,supplier_product_id,supplier_variant_id,unit_cost,shipping_cost,inventory,ship_to,source_status,last_checked_at")
        .eq("supplier_code", "cj").in("variant_id", variantIds),
      db.from("commerce_prices")
        .select("variant_id,selling_price,margin_rate")
        .in("variant_id", variantIds),
      db.from("channel_listings")
        .select("variant_id,external_product_id,external_variant_id,status")
        .eq("channel", "shopify").in("variant_id", variantIds),
    ]);
    if (offersError || pricesError || channelError) {
      throw new Error("color_family_evidence_read_failed:" + (offersError?.message ?? pricesError?.message ?? channelError?.message));
    }
    if ((offers ?? []).length !== FAMILY.length || (prices ?? []).length !== FAMILY.length ||
        (channelRows ?? []).length !== FAMILY.length) {
      throw new Error("color_family_evidence_count_mismatch");
    }

    const offersByVariant = new Map((offers ?? []).map((row) => [String(row.variant_id), row]));
    const pricesByVariant = new Map((prices ?? []).map((row) => [String(row.variant_id), row]));
    const channelsByVariant = new Map((channelRows ?? []).map((row) => [String(row.variant_id), row]));
    const images = new Set<string>();
    const mapped = variants.map((variant) => {
      const vid = String(variant.source_variant_key ?? "");
      const expected = expectedByVid.get(vid);
      if (!expected || String(variant.sku ?? "") !== expected.sku) {
        throw new Error("color_family_supplier_variant_identity_mismatch:" + vid);
      }
      const offer = offersByVariant.get(String(variant.id));
      const price = pricesByVariant.get(String(variant.id));
      const channel = channelsByVariant.get(String(variant.id));
      if (!offer || String(offer.supplier_product_id) !== SUPPLIER_PRODUCT_ID ||
          String(offer.supplier_variant_id) !== vid || offer.source_status !== "verified" ||
          offer.ship_to !== "JP" || Number(offer.inventory) < 1 ||
          Number(offer.unit_cost) <= 0 || Number(offer.shipping_cost) <= 0) {
        throw new Error("color_family_live_supplier_gate_failed:" + expected.sku);
      }
      const checkedAt = Date.parse(String(offer.last_checked_at ?? ""));
      if (!Number.isFinite(checkedAt) || checkedAt > now.getTime() + 5 * 60_000 ||
          now.getTime() - checkedAt > 24 * 60 * 60_000) {
        throw new Error("color_family_supplier_evidence_stale:" + expected.sku);
      }
      if (!price || Number(price.selling_price) <= 0 || Number(price.margin_rate) < 0.5) {
        throw new Error("color_family_margin_gate_failed:" + expected.sku);
      }
      if (!channel || !String(channel.external_product_id ?? "").trim() ||
          !String(channel.external_variant_id ?? "").trim() || channel.status !== "published") {
        throw new Error("color_family_legacy_shopify_identity_missing:" + expected.sku);
      }
      const attributes = asRecord(variant.attributes);
      const imageUrl = attributes.variantImageUrl;
      if (attributes.variantImageIdentityVerified !== true || !validHttpsImage(imageUrl)) {
        throw new Error("color_family_exact_variant_image_unverified:" + expected.sku);
      }
      if (images.has(imageUrl)) throw new Error("color_family_variant_image_not_unique:" + expected.sku);
      images.add(imageUrl);
      return {
        supplierVariantId: vid,
        canonicalVariantId: String(variant.id),
        sourceShopifyProductId: expected.oldProductId,
        sourceShopifyVariantId: expected.oldVariantId,
        sku: expected.sku,
        colorLabel: expected.colorLabel,
        imageUrl,
        colorImageVerified: true,
        price: Number(price.selling_price),
      };
    });

    const snapshots = await readShopifyVariantInventorySnapshot(FAMILY.map((item) => item.oldVariantId));
    if (snapshots.length !== FAMILY.length) throw new Error("color_family_shopify_inventory_snapshot_count_mismatch");
    const locationIds = new Set(snapshots.map((row) => row.locationId));
    if (locationIds.size !== 1) throw new Error("color_family_shopify_inventory_locations_mismatch");
    const inventoryByVariant = new Map(snapshots.map((row) => [row.variantId, row]));
    const inventoryLocationId = snapshots[0].locationId;
    const variantsForShopify = mapped.map((variant) => {
      const snapshot = inventoryByVariant.get(variant.sourceShopifyVariantId);
      if (!snapshot) throw new Error("color_family_shopify_inventory_snapshot_missing:" + variant.sku);
      return { ...variant, inventory: snapshot.available };
    });

    const storeDomain = String(process.env.SHOPIFY_STORE_DOMAIN ?? "").trim()
      .replace(/^https?:\/\//i, "").replace(/\/$/, "");
    if (!storeDomain) throw new Error("shopify_store_domain_missing");
    const created = await createShopifyColorFamily({
      inventoryLocationId,
      title: String(product.title_ja ?? "").trim(),
      descriptionHtml: safeDescriptionHtml(String(product.description_ja ?? "")),
      handle: HANDLE,
      supplierCode: "cj",
      supplierProductId: SUPPLIER_PRODUCT_ID,
      canonicalProductId: String(product.id),
      variants: variantsForShopify,
    });

    const createdBySku = new Map(created.variants.map((row) => [row.sku, row]));
    for (const variant of mapped) {
      const currentChannel = channelsByVariant.get(variant.canonicalVariantId);
      const newVariant = createdBySku.get(variant.sku);
      if (!currentChannel || !newVariant) throw new Error("color_family_channel_identity_readback_missing:" + variant.sku);
      const currentProductId = String(currentChannel.external_product_id ?? "");
      const currentVariantId = String(currentChannel.external_variant_id ?? "");
      if (currentProductId !== variant.sourceShopifyProductId && currentProductId !== created.productId) {
        throw new Error("color_family_channel_product_identity_conflict:" + variant.sku);
      }
      if (currentVariantId !== variant.sourceShopifyVariantId && currentVariantId !== newVariant.id) {
        throw new Error("color_family_channel_variant_identity_conflict:" + variant.sku);
      }
    }

    await activateShopifyProduct(created.productId);
    const publication = await ensureShopifyProductPublished(created.productId);
    if (!publication.published) throw new Error("color_family_new_parent_publish_unverified");

    const oldProductIds = [...new Set(FAMILY.map((item) => item.oldProductId))];
    const oldUnpublishResults = [];
    for (const oldProductId of oldProductIds) {
      const result = await unpublishShopifyProduct(oldProductId);
      if (result.published) throw new Error("color_family_old_product_still_published:" + oldProductId);
      oldUnpublishResults.push({ productId: oldProductId, published: result.published });
    }

    const resultBySku = new Map(created.variants.map((row) => [row.sku, row]));
    const productUrl = "https://" + storeDomain + "/products/" + HANDLE;
    for (const variant of variantsForShopify) {
      const createdVariant = resultBySku.get(variant.sku);
      if (!createdVariant) throw new Error("color_family_new_shopify_variant_missing:" + variant.sku);
      const { error } = await db.from("channel_listings").update({
        external_product_id: created.productId,
        external_variant_id: createdVariant.id,
        external_sku: variant.sku,
        status: "published",
        selling_price: variant.price,
        published_url: productUrl,
        last_error: null,
        last_synced_at: nowIso,
        updated_at: nowIso,
      }).eq("channel", "shopify").eq("variant_id", variant.canonicalVariantId);
      if (error) throw new Error("color_family_channel_listing_update_failed:" + variant.sku + ":" + error.message);

      const current = variants.find((row) => String(row.id) === variant.canonicalVariantId);
      const nextAttributes = { ...asRecord(current?.attributes), colorImageVerified: true };
      const { error: attributeError } = await db.from("commerce_variants")
        .update({ attributes: nextAttributes, updated_at: nowIso })
        .eq("id", variant.canonicalVariantId);
      if (attributeError) throw new Error("color_family_image_verification_persist_failed:" + variant.sku + ":" + attributeError.message);
    }

    return NextResponse.json({
      ok: true,
      status: "PUBLISHED",
      supplierProductId: SUPPLIER_PRODUCT_ID,
      productId: created.productId,
      productUrl,
      variantCount: created.variants.length,
      variants: created.variants,
      inventoryLocationId,
      oldProductsUnpublished: oldUnpublishResults,
      aliasesPreserved: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[TRACER SHOPIFY FIVE-COLOR FAMILY MIGRATION FAILED]", message);
    return NextResponse.json({ ok: false, error: message.slice(0, 240) }, { status: 502 });
  }
}
