import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { getOrosyProductDetail, getOrosyShippingQuote, searchOrosyProducts } from "@/lib/sources/orosy";
import { womenProductPriority } from "@/lib/intelligence/womens-priority";

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

function priceFor(cost: number, shipping: number, retail: number | null): number {
  const landedCost = cost + shipping;
  const floor = Math.ceil((landedCost / 0.62) / 100) * 100;
  const retailFloor = retail && retail > landedCost ? Math.ceil(retail / 100) * 100 : 0;
  return Math.max(floor, retailFloor);
}

function slug(title: string, productId: string, variationId: string): string {
  const base = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 55);
  return `${base || "orosy-product"}-${productId}-${variationId}`.slice(0, 180);
}

async function upsertProduct(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  detail: Awaited<ReturnType<typeof getOrosyProductDetail>>,
  jan: string,
): Promise<string | null> {
  if (!detail || !/^\d{8,14}$/.test(jan)) return null;

  // Reuse an existing canonical record with the same JAN instead of creating a duplicate.
  const canonical = await supabase.from("products").select("id").eq("jan", jan).limit(2);
  if (canonical.error) throw new Error(canonical.error.message);
  if ((canonical.data ?? []).length > 1) return null;
  if (canonical.data?.[0]?.id) return String(canonical.data[0].id);

  const identityKey = `orosy:${detail.id}`;
  const existing = await supabase.from("products").select("id,jan").eq("identity_key", identityKey).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data?.id) {
    if (existing.data.jan && existing.data.jan !== jan) return null;
    const updated = await supabase.from("products").update({ canonical_name: detail.title, jan })
      .eq("id", existing.data.id).select("id").single();
    if (updated.error) throw new Error(updated.error.message);
    return String(updated.data.id);
  }

  const inserted = await supabase.from("products").insert({
    canonical_name: detail.title,
    identity_key: identityKey,
    jan,
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
          const priority = womenProductPriority({ title: detail.title, category: detail.category });
          if (!priority.isWomenFocused) continue;
          // A supplier variant ID is an order locator, not proof of canonical product identity.
          // Require a real JAN before creating a canonical product/listing relationship.
          const variation = detail.variations.find(v => (v.stockQty ?? 0) > 0 && (v.buyerPrice ?? 0) > 0 && v.variationId && /^\d{8,14}$/.test(v.jan ?? ""));
          if (!variation || !variation.jan || variation.currency?.toUpperCase() !== "JPY") continue;
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
    const variation = detail.variations.find(v => (v.stockQty ?? 0) > 0 && (v.buyerPrice ?? 0) > 0 && v.variationId && /^\d{8,14}$/.test(v.jan ?? ""));
    if (!variation || variation.buyerPrice === null || variation.stockQty === null || !variation.jan || !/^\d{8,14}$/.test(variation.jan) || variation.currency?.toUpperCase() !== "JPY") {
      rejected.push({ id: detail.id, reason: "canonical_jan_or_jpy_price_missing" });
      continue;
    }
    const priority = womenProductPriority({ title: detail.title, category: detail.category });
    if (!priority.isWomenFocused) {
      rejected.push({ id: detail.id, reason: "outside_womens_product_strategy" });
      continue;
    }
    let shippingQuote: Awaited<ReturnType<typeof getOrosyShippingQuote>>;
    try {
      shippingQuote = await getOrosyShippingQuote(detail.id);
    } catch {
      rejected.push({ id: `${detail.id}:${variation.variationId}`, reason: "shipping_quote_unavailable" });
      continue;
    }
    if (shippingQuote.unresolved || shippingQuote.amount === null || shippingQuote.amount <= 0 || shippingQuote.currency?.toUpperCase() !== "JPY") {
      rejected.push({ id: `${detail.id}:${variation.variationId}`, reason: "shipping_quote_unresolved" });
      continue;
    }

    // Apply the landed-cost and margin gate before writing canonical or supplier records.
    const sellingPrice = priceFor(variation.buyerPrice, shippingQuote.amount, variation.retailPrice);
    const contributionProfit = sellingPrice - variation.buyerPrice - shippingQuote.amount;
    const contributionMargin = (contributionProfit / sellingPrice) * 100;
    if (!Number.isFinite(sellingPrice) || sellingPrice <= 0 || !Number.isFinite(contributionProfit) || contributionProfit <= 0 || !Number.isFinite(contributionMargin) || contributionMargin < 20) {
      rejected.push({ id: `${detail.id}:${variation.variationId}`, reason: "insufficient_landed_margin" });
      continue;
    }
    const productId = await upsertProduct(supabase, detail, variation.jan);
    if (!productId) {
      rejected.push({ id: `${detail.id}:${variation.variationId}`, reason: "canonical_identity_conflict" });
      continue;
    }

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
      identity_method: "jan",
      identity_status: "linked",
      identity_confidence: 1,
      configured: true,
      orderable: true,
      price_confirmed: true,
      inventory_confirmed: true,
      verification_status: "verified",
      shipping_cost: shippingQuote.amount,
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
      selection_reasons: ["OROSY_BULK_IMPORT", "JAPANESE_TITLE", "WOMEN_FOCUSED", "JAN_VERIFIED", "IN_STOCK", "IMAGE_VERIFIED", "ORDERABLE", "TRACKING_CAPABILITY_VERIFIED", "SHIPPING_QUOTE_VERIFIED"],
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
      shipping_cost: shippingQuote.amount,
      inventory: variation.stockQty,
      orderable: true,
      tracking_available: true,
      identity_method: "jan",
      identity_confidence: 1,
      contribution_profit: contributionProfit,
      contribution_margin: contributionMargin,
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

  // Discovery/linking must never trigger a broad Shopify sync. Publication is a separate, gated job.
  return NextResponse.json({
    ok: true,
    source: "orosy",
    candidates: candidates.size,
    accepted: accepted.length,
    rejected: rejected.length,
    elapsedMs: Date.now() - started,
  });
}
