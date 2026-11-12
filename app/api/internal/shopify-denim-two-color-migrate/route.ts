import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import {
  createShopifyColorFamily,
  readShopifyVariantInventorySnapshot,
} from "@/lib/shopify/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

const PRODUCT_ID = "73436e12-795d-4374-9863-0b94391c572e";
const SUPPLIER_PRODUCT_ID = "1670333800435421184";
const HANDLE = "denim-shoulder-bag-1670333800435421184";
const FAMILY = [
  { supplierVariantId: "1670333800619970560", variantId: "3b28034b-69f9-4659-ab73-d590cbca3950", supplierSku: "CJNS178139901AZ", externalSku: "TRC-3B28034B69F94659AB73D590", colorLabel: "ブラック", oldProductId: "gid://shopify/Product/8668506619948", oldVariantId: "gid://shopify/ProductVariant/46605310820396" },
  { supplierVariantId: "1670333800691273728", variantId: "5e7634aa-63e8-49f9-a0d7-ef28447ebb0e", supplierSku: "CJNS178139902BY", externalSku: "TRC-5E7634AA63E849F9A0D7EF28", colorLabel: "ブルー", oldProductId: "gid://shopify/Product/8668506357804", oldVariantId: "gid://shopify/ProductVariant/46605310165036" },
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
  } catch { return false; }
}

export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  const db = createSupabaseAdminClient();
  const now = new Date();
  const nowIso = now.toISOString();

  try {
    const { data: product, error: productError } = await db.from("commerce_products")
      .select("id,source_key,title_ja,description_ja")
      .eq("id", PRODUCT_ID).maybeSingle();
    if (productError || !product || product.source_key !== "cj:" + SUPPLIER_PRODUCT_ID) {
      throw new Error("denim_color_family_product_identity_mismatch");
    }

    const { data: variants, error: variantsError } = await db.from("commerce_variants")
      .select("id,product_id,source_variant_key,sku,title_ja,attributes")
      .eq("product_id", PRODUCT_ID);
    if (variantsError || !variants || variants.length !== FAMILY.length) {
      throw new Error("denim_color_family_variant_count_mismatch");
    }

    const variantIds = variants.map((row) => String(row.id));
    const [{ data: offers, error: offersError }, { data: prices, error: pricesError }, { data: channelRows, error: channelError }] = await Promise.all([
      db.from("supplier_offers")
        .select("variant_id,supplier_product_id,supplier_variant_id,unit_cost,shipping_cost,inventory,ship_to,source_status,last_checked_at")
        .eq("supplier_code", "cj").in("variant_id", variantIds),
      db.from("commerce_prices").select("variant_id,selling_price,margin_rate").in("variant_id", variantIds),
      db.from("channel_listings").select("variant_id,external_product_id,external_variant_id,status,external_sku")
        .eq("channel", "shopify").in("variant_id", variantIds),
    ]);
    if (offersError || pricesError || channelError
      || (offers ?? []).length !== FAMILY.length
      || (prices ?? []).length !== FAMILY.length
      || (channelRows ?? []).length !== FAMILY.length) {
      throw new Error("denim_color_family_evidence_read_failed");
    }

    const offersByVariant = new Map((offers ?? []).map((row) => [String(row.variant_id), row]));
    const pricesByVariant = new Map((prices ?? []).map((row) => [String(row.variant_id), row]));
    const channelsByVariant = new Map((channelRows ?? []).map((row) => [String(row.variant_id), row]));
    const storeDomain = String(process.env.SHOPIFY_STORE_DOMAIN ?? "").trim()
      .replace(/^https?:\/\//i, "").replace(/\/$/, "");
    if (!storeDomain) throw new Error("shopify_store_domain_missing");
    const currentProductIds = new Set((channelRows ?? []).map((row) => String(row.external_product_id)));
    const legacyProductIdSet = new Set<string>(FAMILY.map((item) => item.oldProductId));
    const alreadyMigrated = (channelRows ?? []).length === FAMILY.length
      && currentProductIds.size === 1
      && !legacyProductIdSet.has(String([...currentProductIds][0]))
      && FAMILY.every((item) => {
        const row = channelsByVariant.get(item.variantId);
        return row?.status === "published"
          && String(row.external_sku ?? "") === item.externalSku
          && Boolean(String(row.external_variant_id ?? ""));
      });
    if (alreadyMigrated) {
      const productId = [...currentProductIds][0];
      return NextResponse.json({
        ok: true,
        status: "ALREADY_MIGRATED",
        productId,
        productUrl: "https://" + storeDomain + "/products/" + HANDLE,
        variantCount: FAMILY.length,
      }, { headers: { "Cache-Control": "no-store" } });
    }
    const mapped = variants.map((variant) => {
      const expected = FAMILY.find((entry) =>
        entry.supplierVariantId === String(variant.source_variant_key)
        && entry.variantId === String(variant.id)
        && entry.supplierSku === String(variant.sku));
      if (!expected) throw new Error("denim_supplier_variant_identity_mismatch");
      const offer = offersByVariant.get(String(variant.id));
      const price = pricesByVariant.get(String(variant.id));
      const channel = channelsByVariant.get(String(variant.id));
      if (!offer || String(offer.supplier_product_id) !== SUPPLIER_PRODUCT_ID
        || String(offer.supplier_variant_id) !== expected.supplierVariantId
        || offer.source_status !== "verified" || offer.ship_to !== "JP"
        || Number(offer.inventory) < 1 || Number(offer.unit_cost) <= 0 || Number(offer.shipping_cost) <= 0) {
        throw new Error("denim_supplier_offer_gate_failed:" + expected.supplierSku);
      }
      const checkedAt = Date.parse(String(offer.last_checked_at ?? ""));
      if (!Number.isFinite(checkedAt) || checkedAt > now.getTime() + 300000
        || now.getTime() - checkedAt > 24 * 60 * 60 * 1000) {
        throw new Error("denim_supplier_offer_stale:" + expected.supplierSku);
      }
      if (!price || Number(price.selling_price) !== 3859 || Number(price.margin_rate) < 0.5) {
        throw new Error("denim_margin_gate_failed:" + expected.supplierSku);
      }
      if (!channel || String(channel.external_product_id) !== expected.oldProductId
        || String(channel.external_variant_id) !== expected.oldVariantId) {
        throw new Error("denim_legacy_shopify_mapping_mismatch:" + expected.supplierSku);
      }
      const attributes = asRecord(variant.attributes);
      if (attributes.variantImageIdentityVerified !== true || attributes.colorImageVerified !== true
        || !validHttpsImage(attributes.variantImageUrl)) {
        throw new Error("denim_color_image_not_verified:" + expected.supplierSku);
      }
      return {
        supplierVariantId: expected.supplierVariantId,
        canonicalVariantId: String(variant.id),
        sourceShopifyProductId: expected.oldProductId,
        sourceShopifyVariantId: expected.oldVariantId,
        sku: expected.externalSku,
        colorLabel: expected.colorLabel,
        imageUrl: String(attributes.variantImageUrl),
        colorImageVerified: true,
        price: Number(price.selling_price),
      };
    });

    const snapshots = await readShopifyVariantInventorySnapshot(FAMILY.map((item) => item.oldVariantId));
    if (snapshots.length !== FAMILY.length || new Set(snapshots.map((row) => row.locationId)).size !== 1) {
      throw new Error("denim_shopify_inventory_snapshot_invalid");
    }
    const inventoryByVariant = new Map(snapshots.map((row) => [row.variantId, row]));
    const inventoryLocationId = snapshots[0].locationId;
    const variantsForShopify = mapped.map((variant) => {
      const snapshot = inventoryByVariant.get(variant.sourceShopifyVariantId);
      if (!snapshot || !Number.isSafeInteger(snapshot.available) || snapshot.available < 0) {
        throw new Error("denim_shopify_inventory_missing:" + variant.sku);
      }
      return { ...variant, inventory: snapshot.available };
    });

    const created = await createShopifyColorFamily({
      inventoryLocationId,
      title: String(product.title_ja ?? "").trim(),
      descriptionHtml: safeDescriptionHtml(String(product.description_ja ?? "")),
      handle: HANDLE,
      supplierCode: "cj",
      supplierProductId: SUPPLIER_PRODUCT_ID,
      canonicalProductId: PRODUCT_ID,
      variants: variantsForShopify,
    });

    const createdBySku = new Map(created.variants.map((row) => [row.sku, row]));
    for (const variant of mapped) {
      const createdVariant = createdBySku.get(variant.sku);
      if (!createdVariant) throw new Error("denim_new_shopify_variant_missing:" + variant.sku);
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
      oldProductsChanged: false,
      channelListingsChanged: false,
      publicationRequiredForCutover: true,
    }, { headers: { "Cache-Control": "no-store" } });

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[TRACER DENIM TWO-COLOR FAMILY MIGRATION FAILED]", message);
    return NextResponse.json({ ok: false, error: message.slice(0, 240) }, { status: 502 });
  }
}
