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
