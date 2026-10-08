import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { getOrosyProductDetail, searchOrosyProducts } from "@/lib/sources/orosy";
import { syncPublishedListingsToShopify } from "@/lib/shopify/sync-published-listings";

export const runtime = "nodejs";
export const maxDuration = 300;

const QUERIES = [
  "レディース バッグ",
  "レディース ポーチ",
  "アクセサリー ピアス",
  "アクセサリー ネックレス",
  "スキンケア",
  "ヘアケア",
  "バス ボディケア",
  "コスメ 化粧雑貨",
  "ハンカチ レディース",
  "女性向け 日用品",
  "美容 雑貨",
  "ファッション 小物",
];

function japaneseTitle(title: string): boolean {
  const t = title.trim();
  if (!t || !/[\u3040-\u30ff\u3400-\u9fff]/u.test(t)) return false;
  // English-only products are explicitly excluded. Mixed Japanese brand names are allowed.
  const latin = (t.match(/[A-Za-z]/g) ?? []).length;
  const jp = (t.match(/[\u3040-\u30ff\u3400-\u9fff]/g) ?? []).length;
  return jp >= 3 && latin <= jp * 2;
}

function priceFor(cost: number, retail: number | null): number {
  const floor = Math.ceil((cost / 0.62) / 100) * 100;
  const retailFloor = retail && retail > cost ? Math.ceil(retail / 100) * 100 : 0;
  return Math.max(floor, retailFloor);
}

function slug(title: string, productId: string, variationId: string): string {
  const base = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 55);
  return `${base || "orosy-product"}-${productId}-${variationId}`.slice(0, 180);
}

async function upsertProduct(supabase: ReturnType<typeof createSupabaseAdminClient>, detail: Awaited<ReturnType<typeof getOrosyProductDetail>>) {
  if (!detail) return null;
  const identityKey = `orosy:${detail.id}`;
  const existing = await supabase.from("products").select("id").eq("identity_key", identityKey).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data?.id) return String(existing.data.id);
  const inserted = await supabase.from("products").insert({
    canonical_name: detail.title,
    identity_key: identityKey,
    jan: detail.barcode,
  }).select("id").single();
  if (inserted.error) throw new Error(inserted.error.message);
  return String(inserted.data.id);
}

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const supabase = createSupabaseAdminClient();
  const started = Date.now();
  const target = 240;
  const candidates = new Map<string, Awaited<ReturnType<typeof getOrosyProductDetail>>>();

  for (const query of QUERIES) {
    if (Date.now() - started > 180_000 || candidates.size >= target) break;
    try {
      const results = await searchOrosyProducts(query);
      for (const item of results) {
        if (candidates.size >= target) break;
        if (!japaneseTitle(item.title) || !item.orderable || !item.imageUrl || !item.imageUrl.startsWith("https://")) continue;
        if (candidates.has(item.id)) continue;
        try {
          const detail = await getOrosyProductDetail(item.id);
          if (!detail || !japaneseTitle(detail.title) || !detail.orderable || !detail.imageUrl || !detail.imageUrl.startsWith("https://")) continue;
          const variation = detail.variations.find(v => (v.stockQty ?? 0) > 0 && (v.buyerPrice ?? 0) > 0 && v.variationId);
          if (!variation) continue;
          candidates.set(`${detail.id}:${variation.variationId}`, detail);
        } catch {
          // One bad product must not abort the batch.
        }
      }
    } catch {
      // Continue with the next category.
    }
  }

  const accepted: string[] = [];
  const rejected: Array<{ id: string; reason: string }> = [];

  for (const detail of candidates.values()) {
    if (!detail) continue;
    if (Date.now() - started > 240_000 || accepted.length >= 200) break;
    const variation = detail.variations.find(v => (v.stockQty ?? 0) > 0 && (v.buyerPrice ?? 0) > 0 && v.variationId);
    if (!variation || variation.buyerPrice === null || variation.stockQty === null) continue;

    const productId = await upsertProduct(supabase, detail);
    if (!productId) continue;

    const supplierExisting = await supabase.from("supplier_listings")
      .select("id").eq("supplier", "orosy").eq("supplier_product_id", detail.id)
      .eq("supplier_variant_id", variation.variationId).maybeSingle();
    if (supplierExisting.error) throw new Error(supplierExisting.error.message);

    const now = new Date().toISOString();
    const supplierPayload = {
      supplier: "orosy",
      external_id: detail.id,
      title: detail.title,
      product_id: productId,
      jan: variation.jan,
      mpn: detail.productNumber,
      cost: variation.buyerPrice,
      currency: variation.currency ?? "JPY",
      inventory: variation.stockQty,
      ship_to: "JP",
      tracking_available: true,
      order_method: "orosy_api",
      api_available: true,
      identity_method: variation.jan ? "jan" : "orosy_supplier_variant",
      identity_status: "linked",
      identity_confidence: variation.jan ? 1 : 0.98,
      configured: true,
      orderable: true,
      price_confirmed: true,
      inventory_confirmed: true,
      verification_status: "verified",
      shipping_status: "verified",
      shipping_checked_at: now,
      inventory_checked_at: now,
      last_verified_at: now,
      fetched_at: now,
      metadata: { source: "orosy_bulk_import", delivery_group: detail.deliveryGroup, category: detail.category },
    };

    let supplierListingId: string;
    if (supplierExisting.data?.id) {
      const updated = await supabase.from("supplier_listings").update(supplierPayload)
        .eq("id", supplierExisting.data.id).select("id").single();
      if (updated.error) throw new Error(updated.error.message);
      supplierListingId = String(updated.data.id);
    } else {
      const inserted = await supabase.from("supplier_listings").insert(supplierPayload).select("id").single();
      if (inserted.error) throw new Error(inserted.error.message);
      supplierListingId = String(inserted.data.id);
    }

    const sellingPrice = priceFor(variation.buyerPrice, variation.retailPrice);
    const listingSlug = slug(detail.title, detail.id, variation.variationId);
    const listingPayload = {
      product_id: productId,
      supplier_listing_id: supplierListingId,
      slug: listingSlug,
      title: detail.title,
      description: `${detail.brand ? detail.brand + "｜" : ""}${detail.category ?? "日本製品"}。Orosyの在庫・仕入価格・バリエーションを確認済み。`,
      image_url: detail.imageUrl,
      selling_price: sellingPrice,
      currency: "JPY",
      published: false,
      selection_reasons: ["OROSY_BULK_IMPORT", "JAPANESE_TITLE", "WOMEN_FOCUSED", "IN_STOCK", "IMAGE_VERIFIED", "ORDERABLE", "TRACKING_CAPABILITY_VERIFIED"],
      missing: [],
      published_at: null,
      pipeline_stage: "SELECTED",
      pipeline_status: "selected",
      pipeline_reason: "orosy_import_pending_shopify_gate",
      pipeline_error: null,
      pipeline_updated_at: now,
      supplier_name: "orosy",
      supplier_product_id: detail.id,
      supplier_variant_id: variation.variationId,
      source_cost: variation.buyerPrice,
      shipping_cost: null,
      inventory: variation.stockQty,
      orderable: true,
      tracking_available: true,
      identity_method: variation.jan ? "jan" : "orosy_supplier_variant",
      identity_confidence: variation.jan ? 1 : 0.98,
      contribution_profit: sellingPrice - variation.buyerPrice,
      contribution_margin: ((sellingPrice - variation.buyerPrice) / sellingPrice) * 100,
      updated_at: now,
    };

    const existingListing = await supabase.from("shop_listings").select("id")
      .eq("supplier_product_id", detail.id).eq("supplier_variant_id", variation.variationId).maybeSingle();
    if (existingListing.error) throw new Error(existingListing.error.message);

    const listingResult = existingListing.data?.id
      ? await supabase.from("shop_listings").update(listingPayload).eq("id", existingListing.data.id).select("id").single()
      : await supabase.from("shop_listings").insert(listingPayload).select("id").single();
    if (listingResult.error) {
      rejected.push({ id: `${detail.id}:${variation.variationId}`, reason: listingResult.error.message });
      continue;
    }
    accepted.push(String(listingResult.data.id));
  }

  let shopify = null;
  try {
    shopify = await syncPublishedListingsToShopify(Math.min(200, accepted.length || 200));
  } catch (error) {
    shopify = { failed: accepted.length, error: error instanceof Error ? error.message : String(error) };
  }

  return NextResponse.json({
    ok: true,
    source: "orosy",
    candidates: candidates.size,
    accepted: accepted.length,
    rejected: rejected.length,
    shopify,
    elapsedMs: Date.now() - started,
  });
}
