import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import {
  createShopifyColorFamily,
  readShopifyVariantInventorySnapshot,
  shopifyGraphQL,
} from "@/lib/shopify/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

// Exact supplier family and former Shopify IDs. No caller-supplied identity.
const SUPPLIER_PRODUCT_ID = "1739211543297925120";
const HANDLE = "fashion-handbag-1739211543297925120";
const FAMILY = [
  { vid: "1739211543398588416", sku: "CJNS192984501AZ", colorLabel: "大・ホワイト", oldProductId: "gid://shopify/Product/8619923111980", oldVariantId: "gid://shopify/ProductVariant/46407117275180" },
  { vid: "1739211543495057408", sku: "CJNS192984502BY", colorLabel: "大・ピンク", oldProductId: "gid://shopify/Product/8619923013676", oldVariantId: "gid://shopify/ProductVariant/46407117013036" },
  { vid: "1739211543574749184", sku: "CJNS192984503CX", colorLabel: "大・ブラック", oldProductId: "gid://shopify/Product/8619948113964", oldVariantId: "gid://shopify/ProductVariant/46407169245228" },
  { vid: "1739211543658635264", sku: "CJNS192984504DW", colorLabel: "大・ヘイズブルー", oldProductId: "gid://shopify/Product/8620148817964", oldVariantId: "gid://shopify/ProductVariant/46407687798828" },
  { vid: "1739211543914487808", sku: "CJNS192984507GT", colorLabel: "中・ブルー", oldProductId: "gid://shopify/Product/8621370474540", oldVariantId: "gid://shopify/ProductVariant/46410255466540" },
  { vid: "1739211543994179584", sku: "CJNS192984508HS", colorLabel: "中・ブラック", oldProductId: "gid://shopify/Product/8621370441772", oldVariantId: "gid://shopify/ProductVariant/46410255433772" },
  { vid: "1739211544103231488", sku: "CJNS192984509IR", colorLabel: "中・ピンク", oldProductId: "gid://shopify/Product/8621370376236", oldVariantId: "gid://shopify/ProductVariant/46410255368236" },
  { vid: "1739211544191311872", sku: "CJNS192984510JQ", colorLabel: "中・ミントグリーン", oldProductId: "gid://shopify/Product/8619923341356", oldVariantId: "gid://shopify/ProductVariant/46407117701164" },
  { vid: "1739211544279392256", sku: "CJNS192984511KP", colorLabel: "中・ホワイト", oldProductId: "gid://shopify/Product/8619923243052", oldVariantId: "gid://shopify/ProductVariant/46407117570092" },
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

function validCjImage(value: unknown): value is string {
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
        .select("variant_id,supplier_product_id,supplier_variant_id,unit_cost,shipping_cost,inventory,ship_to,source_status,tracking_supported,last_checked_at")
        .eq("supplier_code", "cj").in("variant_id", variantIds),
      db.from("commerce_prices")
        .select("variant_id,selling_price,expected_profit,margin_rate,calculated_at")
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

    // Retries accept only exact old IDs or the existing tagged family + exact SKU IDs.
    const familyKey = createHash("sha256").update(["cj", SUPPLIER_PRODUCT_ID].join(":")).digest("hex").slice(0, 24);
    const familyTag = "TRACER_COLOR_FAMILY_" + familyKey;
    const existingFamily = await shopifyGraphQL<{
      products: { nodes: Array<{
        id: string;
        status: string;
        tags: string[];
        metafields: { nodes: Array<{ namespace: string; key: string; value: string }> };
        variants: { nodes: Array<{ id: string; sku: string | null }> };
      }> };
    }>(
      `query ReadExistingTracerNineColorFamily($query: String!) {
        products(first: 10, query: $query) {
          nodes {
            id status tags
            metafields(first: 10, namespace: "tracer") { nodes { namespace key value } }
            variants(first: 100) { nodes { id sku } }
          }
        }
      }`,
      { query: "tag:" + familyTag },
    );
    if (existingFamily.products.nodes.length > 1) throw new Error("color_family_existing_parent_ambiguous");
    const existingParent = existingFamily.products.nodes[0] ?? null;
    const existingVariantsBySku = new Map<string, string>();
    if (existingParent) {
      const fields = new Map(existingParent.metafields.nodes.map((field) => [field.key, field.value]));
      if (!existingParent.tags.includes(familyTag) ||
          fields.get("supplier_code") !== "cj" ||
          fields.get("supplier_product_id") !== SUPPLIER_PRODUCT_ID ||
          fields.get("canonical_product_id") !== String(product.id) ||
          !["DRAFT", "ACTIVE"].includes(existingParent.status)) {
        throw new Error("color_family_existing_parent_identity_mismatch");
      }
      for (const variant of existingParent.variants.nodes) {
        if (!variant.sku) continue;
        if (existingVariantsBySku.has(variant.sku)) throw new Error("color_family_existing_parent_sku_ambiguous:" + variant.sku);
        existingVariantsBySku.set(variant.sku, variant.id);
      }
    }
    for (const expected of FAMILY) {
      const canonical = variants.find((row) => String(row.source_variant_key ?? "") === expected.vid);
      const channel = canonical ? channelsByVariant.get(String(canonical.id)) : null;
      if (!channel) throw new Error("color_family_channel_identity_missing:" + expected.sku);
      const currentProductId = String(channel.external_product_id ?? "");
      const currentVariantId = String(channel.external_variant_id ?? "");
      const original = currentProductId === expected.oldProductId && currentVariantId === expected.oldVariantId;
      const migrated = Boolean(existingParent && currentProductId === existingParent.id &&
        currentVariantId === existingVariantsBySku.get(expected.sku));
      if (!original && !migrated) throw new Error("color_family_channel_identity_conflict:" + expected.sku);
    }

    const images = new Set<string>();
    const mapped = variants.map((variant) => {
      const vid = String(variant.source_variant_key ?? "");
      const expected = expectedByVid.get(vid);
      if (!expected || String(variant.sku ?? "") !== expected.sku ||
          String(variant.title_ja ?? "").trim() !== String(product.title_ja ?? "").trim() + "（" + expected.colorLabel + "）") {
        throw new Error("color_family_supplier_variant_identity_mismatch:" + vid);
      }
      const offer = offersByVariant.get(String(variant.id));
      const price = pricesByVariant.get(String(variant.id));
      const channel = channelsByVariant.get(String(variant.id));
      if (!offer || String(offer.supplier_product_id) !== SUPPLIER_PRODUCT_ID ||
          String(offer.supplier_variant_id) !== vid || offer.source_status !== "verified" ||
          offer.ship_to !== "JP" || Number(offer.inventory) < 1 ||
          Number(offer.unit_cost) <= 0 || Number(offer.shipping_cost) <= 0 ||
          offer.tracking_supported !== true) {
        throw new Error("color_family_live_supplier_gate_failed:" + expected.sku);
      }
      const checkedAt = Date.parse(String(offer.last_checked_at ?? ""));
      if (!Number.isFinite(checkedAt) || checkedAt > now.getTime() + 5 * 60_000 ||
          now.getTime() - checkedAt > 24 * 60 * 60_000) {
        throw new Error("color_family_supplier_evidence_stale:" + expected.sku);
      }
      const pricedAt = Date.parse(String(price?.calculated_at ?? ""));
      if (!price || !Number.isFinite(pricedAt) || pricedAt > now.getTime() + 5 * 60_000 ||
          now.getTime() - pricedAt > 24 * 60 * 60_000 ||
          Number(price.selling_price) < 2500 || Number(price.expected_profit) < 2500 ||
          Number(price.margin_rate) < 0.5) {
        throw new Error("color_family_profit_gate_failed:" + expected.sku);
      }
      if (!channel) throw new Error("color_family_legacy_shopify_identity_missing:" + expected.sku);
      const attributes = asRecord(variant.attributes);
      const imageUrl = attributes.variantImageUrl;
      if (attributes.variantImageIdentityVerified !== true ||
          attributes.colorImageVerified !== true || !validCjImage(imageUrl)) {
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
      const isOriginal = currentProductId === variant.sourceShopifyProductId &&
        currentVariantId === variant.sourceShopifyVariantId;
      const isMigrated = currentProductId === created.productId && currentVariantId === newVariant.id;
      if (!isOriginal && !isMigrated) {
        throw new Error("color_family_channel_identity_conflict:" + variant.sku);
      }
    }

    // Safety gate: create and verify a DRAFT only. Keep every legacy
    // Shopify product published and leave channel_listings untouched until
    // a separate, explicitly approved cutover is performed.
    return NextResponse.json({
      ok: true,
      status: "DRAFT_READY",
      supplierProductId: SUPPLIER_PRODUCT_ID,
      productId: created.productId,
      variantCount: created.variants.length,
      variants: created.variants,
      inventoryLocationId,
      inventoryPerVariant: snapshots.map((row) => ({ variantId: row.variantId, available: row.available })),
      oldProductsChanged: false,
      channelListingsChanged: false,
      publicationRequiredForCutover: true,
      aliasesPreserved: true,
      basePublication: "unchanged_by_design_per_variant_image_api_limitation",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[TRACER SHOPIFY NINE-COLOR FAMILY MIGRATION FAILED]", message);
    return NextResponse.json({ ok: false, error: message.slice(0, 240) }, { status: 502 });
  }
}
