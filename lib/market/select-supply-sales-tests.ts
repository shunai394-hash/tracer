import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { simulateContributionProfit } from "@/lib/intelligence/simulate-profit";
import { evaluateSalesTestGate, SALES_TEST_GATE_PASSED } from "@/lib/market/sales-test-gate";
import { womenProductPriority } from "@/lib/intelligence/womens-priority";
import { localizeProductTitle } from "@/lib/intelligence/japanese-product";

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
  return null;
}
function validHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try { const parsed = new URL(value); return parsed.protocol === "http:" || parsed.protocol === "https:"; } catch { return false; }
}
function slugify(title: string, productId: string): string {
  const base = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 54);
  return (base || "tracer-product") + "-" + productId.slice(-8);
}
function metadataCategory(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const category = (value as Record<string, unknown>).category;
  return typeof category === "string" ? category : null;
}

function listingQuality(row: Record<string, unknown>): number {
  const identity = num(row.identity_confidence) ?? 0; const inventory = Math.max(0, num(row.inventory) ?? 0);
  return (row.identity_status === "linked" ? 1000 : 0) + (row.identity_method ? 100 : 0) + identity * 100 + (row.price_confirmed === true ? 100 : 0) + (row.inventory_confirmed === true ? 100 : 0) + (row.orderable === true ? 100 : 0) + (row.tracking_available === true ? 50 : 0) + (row.api_available === true ? 50 : 0) + (row.supplier_product_id ? 25 : 0) + (row.supplier_variant_id ? 25 : 0) + Math.min(inventory, 1000) / 1000;
}

export type SupplySalesTestResult = { published: number; publishedListingIds: string[]; selectedListingIds: string[]; considered: number; rejected: Array<{ productId: string; reasons: string[] }> };

export async function selectAndPublishSupplySalesTests(productIds: string[], limit = 3, options: { dryRun?: boolean } = {}): Promise<SupplySalesTestResult & { eligibleProductIds?: string[] }> {
  const supabase = createSupabaseAdminClient();
  if (productIds.length === 0 || limit <= 0) return { published: 0, publishedListingIds: [], selectedListingIds: [], considered: 0, rejected: [] };
  const uniqueProductIds = Array.from(new Set(productIds));
  const { data: intelligenceRows, error: intelligenceError } = await supabase.from("opportunity_intelligence").select("product_id,demand_score,search_fit_score,market_gap_score,competition_score,creative_score,selection_score,overall_confidence,selection_eligible,sellability_state,filter_state,profit_state,recommendation_summary,why_now").in("product_id", uniqueProductIds);
  if (intelligenceError) throw new Error(intelligenceError.message);
  const { data: intelligenceBase, error: intelligenceBaseError } = await supabase.from("product_intelligence").select("product_id,normalized_title,image_url,currency,current_price,metadata").in("product_id", uniqueProductIds);
  if (intelligenceBaseError) throw new Error(intelligenceBaseError.message);
  const { data: listings, error: listingError } = await supabase.from("supplier_listings").select("*").in("product_id", uniqueProductIds).order("fetched_at", { ascending: false, nullsFirst: false });
  if (listingError) throw new Error(listingError.message);

  const intelligenceByProduct = new Map((intelligenceRows ?? []).map((row) => [String(row.product_id), row as Record<string, unknown>]));
  const baseByProduct = new Map((intelligenceBase ?? []).map((row) => [String(row.product_id), row as Record<string, unknown>]));
  const listingByProduct = new Map<string, Record<string, unknown>>();
  for (const row of listings ?? []) { const key = String(row.product_id); const candidate = row as Record<string, unknown>; const current = listingByProduct.get(key); if (!current || listingQuality(candidate) > listingQuality(current)) listingByProduct.set(key, candidate); }

  const rejected: Array<{ productId: string; reasons: string[] }> = [];
  const eligible: Array<{ productId: string; listing: Record<string, unknown>; base: Record<string, unknown>; intelligence: Record<string, unknown>; profit: ReturnType<typeof simulateContributionProfit>; quality: number }> = [];
  for (const productId of uniqueProductIds) {
    const reasons: string[] = []; const intelligence = intelligenceByProduct.get(productId); const base = baseByProduct.get(productId); const listing = listingByProduct.get(productId);
    if (!intelligence) reasons.push("opportunity_intelligence_missing"); if (!base) reasons.push("product_intelligence_missing"); if (!listing) reasons.push("supplier_listing_missing");
    if (reasons.length > 0) { rejected.push({ productId, reasons }); continue; }
    if (!intelligence || !base || !listing) { rejected.push({ productId, reasons: ["required_supply_intelligence_missing"] }); continue; }
    if (!validHttpUrl(base.image_url)) reasons.push("image_url_invalid");
    const localizedTitle = localizeProductTitle(base.normalized_title, metadataCategory(base.metadata));
    if (!localizedTitle) reasons.push("japanese_title_unavailable");

    const rawIdentityMethod = String(listing.identity_method ?? "").trim().toLowerCase();
    const supplierVerifiedIdentity = String(listing.verification_status ?? "") === "verified"
      && Boolean(listing.supplier_product_id)
      && Boolean(listing.supplier_variant_id);
    const identityMethod = supplierVerifiedIdentity ? "supplier_variant" : rawIdentityMethod;
    const identifierGradeMethods = new Set(["asin", "jan", "gtin", "ean", "upc", "mpn", "brand_mpn", "tracer_catalog", "supplier_variant"]);
    if (!supplierVerifiedIdentity && (listing.identity_status !== "linked" || !identifierGradeMethods.has(identityMethod))) reasons.push("identity_not_confirmed");
    if (supplierVerifiedIdentity) {
      if (num(listing.identity_confidence) === null || (num(listing.identity_confidence) ?? 0) < 0.88) listing.identity_confidence = 1;
    } else if (num(listing.identity_confidence) === null || (num(listing.identity_confidence) ?? 0) < 0.88) reasons.push("identity_confidence_low");

    const metadata = base.metadata && typeof base.metadata === "object" && !Array.isArray(base.metadata) ? base.metadata as Record<string, unknown> : {};
    const sellingPrice = num(metadata.selling_price_jpy);
    if (sellingPrice === null || sellingPrice <= 0) reasons.push("selling_price_unknown");
    const sourceCost = num(listing.cost); const shippingCost = num(listing.shipping_cost);
    if (sourceCost !== null && sourceCost < 0) reasons.push("source_cost_invalid");
    if (shippingCost !== null && shippingCost < 0) reasons.push("shipping_cost_invalid");

    const sourceFxRateToSelling = num(metadata.fx_rate);
    const profit = simulateContributionProfit({
      sellingPrice,
      sellingCurrency: "JPY",
      sellingProvider: "tracer_supply",
      sourceCost,
      sourceCurrency: typeof listing.currency === "string" ? listing.currency : "USD",
      sourceProvider: String(listing.supplier ?? "unknown"),
      internationalShipping: shippingCost,
      domesticShipping: null,
      shippingCurrency: typeof listing.currency === "string" ? listing.currency : "USD",
      sourceFxRateToSelling,
      sourceFxRateSource: sourceFxRateToSelling !== null ? "supplier_listing_metadata" : undefined,
    });
    const gate = evaluateSalesTestGate({ rank: null, title: localizedTitle, sellingPrice, identityLinked: supplierVerifiedIdentity || (listing.identity_status === "linked" && identifierGradeMethods.has(identityMethod)), identityMethod, identityConfidence: num(listing.identity_confidence), sourceCost, shippingCost, trackingAvailable: listing.tracking_available === true, apiAvailable: listing.api_available === true, profitCalculable: profit.calculable, shippingUnknown: profit.shippingUnknown, contributionProfit: profit.contributionProfit, currencyMismatch: false, priceConfirmed: listing.price_confirmed === true, inventoryConfirmed: listing.inventory_confirmed === true, inventory: num(listing.inventory), orderable: listing.orderable === true, supplierProductId: typeof listing.supplier_product_id === "string" ? listing.supplier_product_id : null, supplierVariantId: typeof listing.supplier_variant_id === "string" ? listing.supplier_variant_id : null, requireRank: false });
    if (!gate.eligible) reasons.push(...gate.reasons);
    const supplySalesTestReady =
      supplierVerifiedIdentity &&
      profit.calculable &&
      profit.contributionMargin !== null &&
      profit.contributionMargin > 0;
    if (!supplySalesTestReady) {
      if (String(intelligence.sellability_state ?? "") !== "TEST_READY") reasons.push("sellability_not_ready");
      if (String(intelligence.filter_state ?? "") !== "PASS") reasons.push("intelligence_filter_not_pass");
      if (String(intelligence.profit_state ?? "") !== "PROFIT_OK") reasons.push("intelligence_profit_not_ok");
    }
    if (!supplySalesTestReady) {
      if (num(intelligence.demand_score) === null) reasons.push("demand_evidence_missing");
      if (num(intelligence.search_fit_score) === null) reasons.push("search_fit_evidence_missing");
      if (num(intelligence.market_gap_score) === null) reasons.push("market_gap_evidence_missing");
      if (num(intelligence.overall_confidence) === null || (num(intelligence.overall_confidence) ?? 0) < 0.6) reasons.push("intelligence_confidence_low");
    }
    if (reasons.length) { rejected.push({ productId, reasons: Array.from(new Set(reasons)) }); continue; }

    const womenBonus = womenProductPriority({ title: typeof base.normalized_title === "string" ? base.normalized_title : "", category: typeof metadata.category === "string" ? metadata.category : null }).bonus;
    const quality = (num(intelligence.selection_score) ?? 0) * 0.45 + (num(intelligence.demand_score) ?? 0) * 0.2 + (num(intelligence.search_fit_score) ?? 0) * 0.1 + (num(intelligence.market_gap_score) ?? 0) * 0.1 + (num(intelligence.competition_score) ?? 0) * 0.05 + (num(intelligence.creative_score) ?? 0) * 0.05 + (num(intelligence.overall_confidence) ?? 0) * 100 * 0.05 + womenBonus;
    eligible.push({ productId, listing, base, intelligence, profit, quality });
  }

  eligible.sort((a, b) => {
    const womenA = womenProductPriority({ title: typeof a.base.normalized_title === "string" ? a.base.normalized_title : "", category: a.base.metadata && typeof a.base.metadata === "object" && !Array.isArray(a.base.metadata) && typeof (a.base.metadata as Record<string, unknown>).category === "string" ? String((a.base.metadata as Record<string, unknown>).category) : null });
    const womenB = womenProductPriority({ title: typeof b.base.normalized_title === "string" ? b.base.normalized_title : "", category: b.base.metadata && typeof b.base.metadata === "object" && !Array.isArray(b.base.metadata) && typeof (b.base.metadata as Record<string, unknown>).category === "string" ? String((b.base.metadata as Record<string, unknown>).category) : null });
    if (womenB.bonus !== womenA.bonus) return womenB.bonus - womenA.bonus;
    return b.quality - a.quality;
  });
  if (options.dryRun) return { published: 0, publishedListingIds: [], selectedListingIds: [], considered: uniqueProductIds.length, rejected: rejected.slice(0, 50), eligibleProductIds: eligible.map((item) => item.productId) };
  const eligibleProductIds = eligible.map((item) => item.productId);
  const { data: liveListings, error: liveListingsError } = await supabase.from("shop_listings").select("product_id").in("product_id", eligibleProductIds).eq("published", true).in("pipeline_status", ["published"]);
  if (liveListingsError) throw new Error(liveListingsError.message);
  const liveProductIds = new Set((liveListings ?? []).map((row) => String(row.product_id ?? "")).filter(Boolean));
  const chosen = eligible.filter((item) => !liveProductIds.has(item.productId)).slice(0, limit); const publishedListingIds: string[] = []; const selectedListingIds: string[] = [];
  for (const item of chosen) {
    const title = localizeProductTitle(item.base.normalized_title, metadataCategory(item.base.metadata)) ?? String(item.base.normalized_title ?? ("TRACER product " + item.productId)); const slug = slugify(title, item.productId); const now = new Date().toISOString();
    const metadata = item.base.metadata && typeof item.base.metadata === "object" && !Array.isArray(item.base.metadata) ? item.base.metadata as Record<string, unknown> : {};
    const payload = { product_id: item.productId, bestseller_id: null, supplier_listing_id: item.listing.id, slug, title, description: typeof item.intelligence.recommendation_summary === "string" && item.intelligence.recommendation_summary.trim() ? item.intelligence.recommendation_summary.trim().slice(0, 700) : "需要・供給・利益・公開条件を確認したTRACERセレクト商品です。", image_url: item.base.image_url, selling_price: num(metadata.selling_price_jpy), currency: "JPY", supplier_name: String(item.listing.supplier ?? "unknown"), supplier_product_id: item.listing.supplier_product_id, supplier_variant_id: item.listing.supplier_variant_id, source_cost: item.profit.sourceCost, shipping_cost: item.profit.internationalShipping, inventory: num(item.listing.inventory), orderable: item.listing.orderable === true, tracking_available: item.listing.tracking_available === true, identity_method: (String(item.listing.verification_status ?? "") === "verified" && item.listing.supplier_product_id && item.listing.supplier_variant_id) ? "supplier_variant" : (item.listing.identity_method ?? "supply_discovered"), identity_confidence: (String(item.listing.verification_status ?? "") === "verified" && item.listing.supplier_product_id && item.listing.supplier_variant_id) ? 1 : num(item.listing.identity_confidence), contribution_profit: item.profit.contributionProfit, contribution_margin: item.profit.contributionMargin, published: false, selection_reasons: [SALES_TEST_GATE_PASSED, "sales_test_gate:supply", "supply_intelligence_gate_passed", "selection_score_" + (num(item.intelligence.selection_score)?.toFixed(1) ?? "0")], missing: [], published_at: null, pipeline_stage: "SELECTED", pipeline_status: "selected", pipeline_reason: "sales_test_selected_pending_shopify", pipeline_error: null, pipeline_updated_at: now, updated_at: now };
    const existing = await supabase.from("shop_listings").select("id").eq("slug", slug).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    let existingId = existing.data?.id ? String(existing.data.id) : null; let keepSlug = false;
    if (!existingId) { const byProduct = await supabase.from("shop_listings").select("id").eq("product_id", item.productId).order("updated_at", { ascending: false }).limit(1).maybeSingle(); if (byProduct.error) throw new Error(byProduct.error.message); if (byProduct.data?.id) { existingId = String(byProduct.data.id); keepSlug = true; } }
    const { slug: _slug, ...payloadWithoutSlug } = payload; void _slug;
    const result = existingId ? await supabase.from("shop_listings").update(keepSlug ? payloadWithoutSlug : payload).eq("id", existingId).select("id").single() : await supabase.from("shop_listings").insert(payload).select("id").single();
    if (result.error) throw new Error(result.error.message);
    if (result.data?.id) { const listingId = String(result.data.id); selectedListingIds.push(listingId); publishedListingIds.push(listingId); }
  }
  return { published: publishedListingIds.length, publishedListingIds, selectedListingIds, considered: uniqueProductIds.length, rejected: rejected.slice(0, 50) };
}
