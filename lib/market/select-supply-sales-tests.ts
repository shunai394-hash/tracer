import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { PROFIT_ASSUMPTIONS, simulateContributionProfit } from "@/lib/intelligence/simulate-profit";
import { evaluateSalesTestGate, SALES_TEST_GATE_PASSED } from "@/lib/market/sales-test-gate";
import { womenProductPriority } from "@/lib/intelligence/womens-priority";
import { isJapaneseProductTitle, localizeProductDescription, localizeProductTitle } from "@/lib/intelligence/japanese-product";
import { isPublishableCatalogDescription, isPublishableCatalogTitle } from "@/lib/catalog/publishable-title";
import { getObservedUsdToJpyRate } from "@/lib/intelligence/fx";
import { isNativeCjSupplierListing } from "@/lib/catalog/canonical-supplier-identity";
import { calculateSupplySellingPriceJpy, resolveSupplierFxRateToJpy, resolveUnknownShippingAllowanceUsd } from "@/lib/market/supply-pricing";
import { persistedListingShippingCost } from "@/lib/market/listing-shipping-cost";

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
  return null;
}
function validHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try { const parsed = new URL(value); return parsed.protocol === "http:" || parsed.protocol === "https:"; } catch { return false; }
}
function firstImageUrl(...sources: unknown[]): string | null {
  const keys = ["image_url", "imageUrl", "product_image_url", "productImageUrl", "productImage", "main_image", "mainImage", "image", "images", "product_images", "productImages"];
  const candidates: unknown[] = [];
  const add = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) add(item); return; }
    if (value && typeof value === "object") {
      const item = value as Record<string, unknown>;
      for (const key of ["url", "src", "original", "large", "medium"]) if (item[key] !== undefined) add(item[key]);
      return;
    }
    if (typeof value === "string") candidates.push(value);
  };
  for (const source of sources) {
    if (source && typeof source === "object" && !Array.isArray(source)) {
      const row = source as Record<string, unknown>;
      for (const key of keys) if (row[key] !== undefined) add(row[key]);
    } else add(source);
  }
  return candidates.find(validHttpUrl) as string | undefined ?? null;
}
function localizedDescriptionFallback(title: string): string | null {
  const normalized = title.normalize("NFKC").replace(/\\s+/g, " ").trim();
  if (/レディース.{0,8}ショルダーバッグ|ショルダーバッグ.{0,8}レディース/.test(normalized)) {
    return "日常のお出かけや荷物の持ち運びに使うレディースショルダーバッグです。サイズ・素材・収納部・ストラップ仕様は販売元の最新情報をご確認ください。";
  }
  if (/ヘアクリップ/.test(normalized)) {
    return "髪をまとめるためのヘアクリップです。サイズ・材質・留め具の仕様は販売元の最新情報をご確認ください。";
  }
  if (/きのこ型メイクパフ/.test(normalized)) {
    return "ファンデーションなどのメイクに使うきのこ型メイクパフです。材質・寸法・使用方法・お手入れ方法は販売元の最新情報をご確認ください。";
  }
  // Conservative copy for a specific Japanese title when no curated rule matches.
  // Supplier identity, image, shipping, stock, price, profit and orderability gates remain unchanged.
  if (isJapaneseProductTitle(normalized) && isPublishableCatalogTitle(normalized)) {
    return `「${normalized}」の商品です。購入前に、商品画像・選択中のバリエーション・寸法・素材・付属品・使用条件を販売元の最新情報でご確認ください。`;
  }
  return null;
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

export type SupplySalesTestResult = {
  published: number;
  publishedListingIds: string[];
  selectedListingIds: string[];
  considered: number;
  rejectedCount: number;
  rejectionCounts: Record<string, number>;
  rejected: Array<{ productId: string; reasons: string[]; title?: string; masterTitle?: string; category?: string | null; supplier?: string; categoryPriority?: number; sellingPrice?: number | null; sourceCost?: number | null; internationalShipping?: number | null; domesticShippingKnown?: boolean; contributionProfit?: number | null; contributionMargin?: number | null }>;
};

function summarizeRejections(rows: Array<{ reasons: string[] }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) for (const reason of row.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
  return counts;
}

export async function selectAndPublishSupplySalesTests(productIds: string[], limit = 3, options: { dryRun?: boolean; allowNativeCjIdentity?: boolean } = {}): Promise<SupplySalesTestResult & { eligibleProductIds?: string[]; eligibleSamples?: Array<Record<string, unknown>> }> {
  const supabase = createSupabaseAdminClient();
  const observedFx = await getObservedUsdToJpyRate();
  if (productIds.length === 0 || limit <= 0) return { published: 0, publishedListingIds: [], selectedListingIds: [], considered: 0, rejectedCount: 0, rejectionCounts: {}, rejected: [] };
  const uniqueProductIds = Array.from(new Set(productIds));
  // Supply-first items have their own TRACER products, but intentionally keep
  // supplier_listings.product_id null until marketplace identity is proven.
  // Resolve that internal association through deterministic source_ref /
  // products.identity_key without writing a canonical marketplace link.
  const { data: productIdentityRows, error: productIdentityError } = await supabase
    .from("products")
    .select("id,identity_key")
    .in("id", uniqueProductIds);
  if (productIdentityError) throw new Error(productIdentityError.message);
  const sourceRefToProductId = new Map<string, string>();
  for (const row of productIdentityRows ?? []) {
    if (typeof row.identity_key === "string" && row.identity_key.trim()) sourceRefToProductId.set(row.identity_key, String(row.id));
  }
  const sourceRefs = [...sourceRefToProductId.keys()];

  // Apply live inventory holds to linked and detached supply rows alike.
  const { data: heldRows, error: heldRowsError } = await supabase
    .from("supplier_listings")
    .select("product_id")
    .in("product_id", uniqueProductIds)
    .eq("verification_error", "storefront_stock_cap_deploy_pending");
  if (heldRowsError) throw new Error(heldRowsError.message);
  // Avoid a potentially oversized PostgREST JSON-path IN query. Detached rows
  // are fetched below by indexed supplier_product_id; apply the same hold from
  // those bounded scalar-query results after reconstructing their exact identity.
  const heldProductIds = new Set((heldRows ?? []).map((row) => String(row.product_id ?? "")).filter(Boolean));

  const { data: intelligenceRows, error: intelligenceError } = await supabase.from("opportunity_intelligence").select("product_id,demand_score,search_fit_score,market_gap_score,competition_score,creative_score,selection_score,overall_confidence,selection_eligible,sellability_state,filter_state,profit_state,recommendation_summary,why_now").in("product_id", uniqueProductIds);
  if (intelligenceError) throw new Error(intelligenceError.message);
  const { data: intelligenceBase, error: intelligenceBaseError } = await supabase.from("product_intelligence").select("product_id,normalized_title,image_url,currency,current_price,metadata").in("product_id", uniqueProductIds);
  if (intelligenceBaseError) throw new Error(intelligenceBaseError.message);
  const { data: linkedListings, error: linkedListingError } = await supabase.from("supplier_listings").select("*").in("product_id", uniqueProductIds).order("fetched_at", { ascending: false, nullsFirst: false });
  if (linkedListingError) throw new Error(linkedListingError.message);
  // PostgREST JSON-path filters on metadata->>source_ref have behaved
  // inconsistently for the detached supply-first rows. Resolve the same
  // deterministic CJ identity through indexed scalar columns instead, then
  // reconstruct the source_ref in memory. This keeps supplier identity exact
  // without linking a CJ item to an unrelated marketplace product.
  const sourceIdentityPairs = sourceRefs.map((sourceRef) => {
    // Canonical supply-first identity_key format is
    // "cj:product:<supplierProductId>:variant:<supplierVariantId>".
    // Parse the labeled segments rather than positional split indexes: using
    // parts[1] here returned the literal word "product", causing every detached
    // supplier listing lookup to miss and reject valid supply as missing.
    const labeledMatch = /^cj:product:([^:]+):variant:(.+)$/.exec(sourceRef);
    const legacyMatch = /^cj:([^:]+):([^:]+)$/.exec(sourceRef);
    return {
      sourceRef,
      productId: sourceRefToProductId.get(sourceRef) ?? null,
      supplierProductId: labeledMatch?.[1] ?? legacyMatch?.[1] ?? "",
      supplierVariantId: labeledMatch?.[2] ?? legacyMatch?.[2] ?? "",
    };
  }).filter((item) => item.productId && item.supplierProductId && item.supplierVariantId);
  const detachedSupplierProductIds = [...new Set(sourceIdentityPairs.map((item) => item.supplierProductId))];
  const { data: detachedListings, error: detachedListingError } = detachedSupplierProductIds.length
    ? await supabase.from("supplier_listings").select("*")
        .in("supplier", ["cj", "cjdropshipping"])
        .in("supplier_product_id", detachedSupplierProductIds)
        .order("fetched_at", { ascending: false, nullsFirst: false })
    : { data: [], error: null };
  if (detachedListingError) throw new Error(detachedListingError.message);
  for (const row of detachedListings ?? []) {
    if (row.verification_error !== "storefront_stock_cap_deploy_pending") continue;
    const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
    const metadataSourceRef = typeof metadata.source_ref === "string" ? metadata.source_ref : "";
    const sourceRef = metadataSourceRef || `cj:${String(row.supplier_product_id ?? "")}:${String(row.supplier_variant_id ?? "")}`;
    const productId = sourceRefToProductId.get(sourceRef)
      ?? sourceIdentityPairs.find((item) => item.sourceRef === sourceRef)?.productId
      ?? sourceIdentityPairs.find((item) => item.supplierProductId === String(row.supplier_product_id ?? "") && item.supplierVariantId === String(row.supplier_variant_id ?? ""))?.productId;
    if (productId) heldProductIds.add(productId);
  }
  const sourceRefBySupplierIdentity = new Map(
    sourceIdentityPairs.map((item) => [`${item.supplierProductId}:${item.supplierVariantId}`, item]),
  );
  const listingsById = new Map<string, Record<string, unknown>>();
  for (const row of linkedListings ?? []) listingsById.set(String(row.id), row as Record<string, unknown>);
  for (const row of detachedListings ?? []) {
    const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
    const metadataSourceRef = typeof metadata.source_ref === "string" ? metadata.source_ref : "";
    const sourceRef = metadataSourceRef || `cj:${String(row.supplier_product_id ?? "")}:${String(row.supplier_variant_id ?? "")}`;
    const identityPair = sourceIdentityPairs.find((item) => item.sourceRef === sourceRef)
      ?? sourceRefBySupplierIdentity.get(`${String(row.supplier_product_id ?? "")}:${String(row.supplier_variant_id ?? "")}`);
    const productId = identityPair?.productId ?? sourceRefToProductId.get(sourceRef);
    if (productId) {
      listingsById.set(String(row.id), !row.product_id
        ? { ...(row as Record<string, unknown>), product_id: productId }
        : row as Record<string, unknown>);
    }
  }
  const listings = [...listingsById.values()];

  const intelligenceByProduct = new Map((intelligenceRows ?? []).map((row) => [String(row.product_id), row as Record<string, unknown>]));
  const baseByProduct = new Map((intelligenceBase ?? []).map((row) => [String(row.product_id), row as Record<string, unknown>]));
  const listingByProduct = new Map<string, Record<string, unknown>>();
  // Keep the best observed listing for diagnostics even when it is not yet
  // orderable. Otherwise a real supplier row with incomplete fulfillment proof
  // is mislabeled as "supplier_listing_missing", hiding the actionable blocker.
  const observedListingByProduct = new Map<string, Record<string, unknown>>();
  const identifierGradeMethods = new Set(["asin", "jan", "gtin", "ean", "upc", "mpn", "brand_mpn", "tracer_catalog"]);
  const listingCandidatesByProduct = new Map<string, Record<string, unknown>[]>();
  for (const row of listings ?? []) {
    const candidate = row as Record<string, unknown>;
    const key = String(candidate.product_id ?? "");
    if (!key) continue;
    const bucket = listingCandidatesByProduct.get(key) ?? [];
    bucket.push(candidate);
    listingCandidatesByProduct.set(key, bucket);
  }
  for (const [productId, candidates] of listingCandidatesByProduct) {
    const observedBest = candidates.reduce<Record<string, unknown> | null>((current, candidate) =>
      !current || listingQuality(candidate) > listingQuality(current) ? candidate : current, null);
    if (observedBest) observedListingByProduct.set(productId, observedBest);
    // A stale/unverified supplier row must not mask a different, currently
    // verified variant for the same canonical product. Prefer only rows that
    // already satisfy the live supply/identity prerequisites, then rank those.
    const verifiedCandidates = candidates.filter((candidate) => {
      const supplier = String(candidate.supplier ?? "").trim().toLowerCase();
      const nativeSupplierIdentity = options.allowNativeCjIdentity === true && isNativeCjSupplierListing(candidate);
      const canonicalIdentity = candidate.identity_status === "linked"
        && identifierGradeMethods.has(String(candidate.identity_method ?? "").trim().toLowerCase())
        && (num(candidate.identity_confidence) ?? 0) >= 0.88;
      return (nativeSupplierIdentity || canonicalIdentity)
        && Boolean(candidate.supplier_product_id)
        && Boolean(candidate.supplier_variant_id)
        && candidate.price_confirmed === true
        && candidate.inventory_confirmed === true
        && (num(candidate.inventory) ?? 0) > 0
        && candidate.orderable === true
        && candidate.tracking_available === true
        && candidate.api_available === true;
    });
    // Fail closed: if no supplier offer passes identity, freshness, inventory and orderability checks, publish none.
    const pool = verifiedCandidates;
    const best = pool.reduce<Record<string, unknown> | null>((current, candidate) =>
      !current || listingQuality(candidate) > listingQuality(current) ? candidate : current, null);
    if (best) listingByProduct.set(productId, best);
  }

  const rejected: SupplySalesTestResult["rejected"] = [];
  const eligible: Array<{ productId: string; listing: Record<string, unknown>; base: Record<string, unknown>; intelligence: Record<string, unknown>; profit: ReturnType<typeof simulateContributionProfit>; quality: number; description: string; shippingAllowanceUsd: number; imageUrl: string }> = [];
  for (const productId of uniqueProductIds) {
    if (heldProductIds.has(productId)) {
      const heldListing = listingByProduct.get(productId);
      rejected.push({
        productId,
        reasons: ["supplier_inventory_reverification_required"],
        title: typeof heldListing?.title === "string" ? heldListing.title : undefined,
        supplier: typeof heldListing?.supplier === "string" ? heldListing.supplier : undefined,
      });
      continue;
    }
    const reasons: string[] = []; const intelligence = intelligenceByProduct.get(productId) ?? { product_id: productId, demand_score: null, search_fit_score: null, market_gap_score: null, competition_score: null, creative_score: null, selection_score: null, overall_confidence: null, selection_eligible: false, sellability_state: null, filter_state: null, profit_state: null, recommendation_summary: null, why_now: null }; const observedBase = baseByProduct.get(productId); const listing = listingByProduct.get(productId) ?? observedListingByProduct.get(productId);
    // Supplier-native products may not have a product_intelligence row yet.
    // When the exact supplier listing already carries its own title and image,
    // use that evidence as a local catalog fallback instead of rejecting it
    // solely because the enrichment job has not populated product_intelligence.
    const listingMetadata = listing?.metadata && typeof listing.metadata === "object" && !Array.isArray(listing.metadata) ? listing.metadata as Record<string, unknown> : {};
    const listingImage = firstImageUrl(
      listing?.image_url,
      listing?.image,
      listing?.product_image_url,
      listing?.productImageUrl,
      listingMetadata,
    );
    // Keep the canonical intelligence title/metadata, but recover a missing or
    // invalid catalog image from the exact verified supplier variant. The
    // supplier image is persisted from CJ's product detail response and must not
    // be discarded just because an older product_intelligence row exists.
    const base = observedBase
      ? {
          ...observedBase,
          image_url: validHttpUrl(observedBase.image_url)
            ? observedBase.image_url
            : (validHttpUrl(listingImage) ? listingImage : null),
          metadata: observedBase.metadata ?? listingMetadata,
        } as Record<string, unknown>
      : (typeof listing?.title === "string" && listing.title.trim() ? {
          product_id: productId,
          normalized_title: listing.title,
          image_url: validHttpUrl(listingImage) ? listingImage : null,
          metadata: listingMetadata,
        } as Record<string, unknown> : undefined);
    const sourceTitle = (typeof listingMetadata.source_title === "string" && listingMetadata.source_title.trim()
      ? listingMetadata.source_title
      : typeof listingMetadata.sourceTitle === "string" && listingMetadata.sourceTitle.trim()
        ? listingMetadata.sourceTitle
        : typeof listing?.title === "string" && listing.title.trim()
          ? listing.title
          : typeof base?.normalized_title === "string" ? base.normalized_title : "").normalize("NFKC").trim();
    // A concrete supplier title must not mask a generic or workflow-derived
    // product-master title (for example "トレンド・seeded_dueアイテム").
    const masterTitle = (typeof base?.normalized_title === "string" ? base.normalized_title : "").normalize("NFKC").trim();
    const nativeCjSupplyIdentity = Boolean(listing && options.allowNativeCjIdentity === true && isNativeCjSupplierListing(listing));
    // The supplier's concrete title is the listing source of truth. A generic
    // legacy product-master title must not suppress a verified supplier offer;
    // the localized supplier title and placeholder checks below are authoritative.
    const sourceMetadata = base?.metadata && typeof base.metadata === 'object' && !Array.isArray(base.metadata) ? base.metadata as Record<string, unknown> : {};
    const womenPriority = womenProductPriority({
      title: sourceTitle,
      category: typeof sourceMetadata.category === "string" ? sourceMetadata.category : null,
      query: typeof sourceMetadata.query === "string" ? sourceMetadata.query : null,
    });
    // Women's relevance is a ranking bonus, not an exclusion rule. Margin is
    // reported for the merchant's pricing decision, not used as a publication veto.
    // Product identity, Japanese copy and fulfillment evidence remain required.
    if (/(暮らしの便利アイテム|トレンド[・ -]*seeded_dueアイテム|商品アイデンティティが未確定|^未分類$|^商品$|^item$|^product$)/i.test(sourceTitle)) reasons.push('generic_non_merchandisable_title');
    if (!base) reasons.push("product_intelligence_or_supplier_catalog_missing");
    if (!listing) reasons.push("supplier_listing_missing");
    else {
      if (listing.orderable !== true) reasons.push("supplier_listing_not_orderable");
      if (listing.api_available !== true) reasons.push("supplier_order_api_unverified");
      if (listing.tracking_available !== true) reasons.push("supplier_tracking_unverified");
      if (listing.price_confirmed !== true) reasons.push("supplier_price_unverified");
      if (listing.inventory_confirmed !== true || (num(listing.inventory) ?? 0) <= 0) reasons.push("supplier_inventory_unverified");
    }
    if (reasons.length > 0) { rejected.push({ productId, reasons, title: sourceTitle, masterTitle, category: metadataCategory(base?.metadata), supplier: String(listing?.supplier ?? "unknown"), categoryPriority: womenPriority.categoryPriority }); continue; }
    if (!base || !listing) { rejected.push({ productId, reasons: ["required_catalog_or_supplier_data_missing"], title: sourceTitle, masterTitle, category: metadataCategory(base?.metadata), supplier: String(listing?.supplier ?? "unknown"), categoryPriority: womenPriority.categoryPriority }); continue; }
    const supplierMetadata = listing.metadata && typeof listing.metadata === "object" && !Array.isArray(listing.metadata)
      ? listing.metadata as Record<string, unknown>
      : {};
    const baseMetadata = base.metadata && typeof base.metadata === "object" && !Array.isArray(base.metadata) ? base.metadata as Record<string, unknown> : {};
    const productImageUrl = firstImageUrl(
      typeof base.image_url === "string" ? base.image_url : null,
      baseMetadata,
      supplierMetadata,
    );
    if (!productImageUrl) reasons.push("image_url_invalid");
    const localizedTitle = localizeProductTitle(sourceTitle, metadataCategory(base.metadata));
    if (!isJapaneseProductTitle(localizedTitle)) reasons.push("japanese_title_unavailable");
    else if (!isPublishableCatalogTitle(localizedTitle)) reasons.push("catalog_title_not_publishable");
    const recommendationSummary = typeof intelligence.recommendation_summary === "string" ? intelligence.recommendation_summary.trim() : null;
    const localizedDescription = localizeProductDescription(sourceTitle)
      ?? localizeProductDescription(localizedTitle)
      ?? localizedDescriptionFallback(typeof localizedTitle === "string" ? localizedTitle : "");
    const publishableDescription = isPublishableCatalogDescription(localizedDescription)
      ? localizedDescription
      : isPublishableCatalogDescription(recommendationSummary) ? recommendationSummary : null;
    if (!publishableDescription) reasons.push("japanese_description_unavailable");

    const rawIdentityMethod = String(listing.identity_method ?? "").trim().toLowerCase();
    const identifierGradeMethods = new Set(["asin", "jan", "gtin", "ean", "upc", "mpn", "brand_mpn", "tracer_catalog"]);
    // Supplier API verification proves that the supplier SKU is real and orderable;
    // it does not prove that it is the same item as the marketplace demand product.
    // Only an explicit server-side identity link with identifier-grade evidence may
    // pass this gate. Never infer marketplace identity from verification_status.
    
    const supplierVerifiedIdentity = nativeCjSupplyIdentity || (
      listing.identity_status === "linked"
      && identifierGradeMethods.has(rawIdentityMethod)
      && Boolean(listing.supplier_product_id)
      && Boolean(listing.supplier_variant_id)
      && num(listing.identity_confidence) !== null
      && (num(listing.identity_confidence) ?? 0) >= 0.88
    );
    const identityMethod = nativeCjSupplyIdentity ? "cj_supplier_variant" : rawIdentityMethod;
    if (!supplierVerifiedIdentity) reasons.push("identity_not_confirmed");
    if (!nativeCjSupplyIdentity && (num(listing.identity_confidence) === null || (num(listing.identity_confidence) ?? 0) < 0.88)) reasons.push("identity_confidence_low");

    const metadata = base.metadata && typeof base.metadata === "object" && !Array.isArray(base.metadata) ? base.metadata as Record<string, unknown> : {};
    let sellingPrice = num(metadata.selling_price_jpy);
    const sourceCost = num(listing.cost); const shippingCost = num(listing.shipping_cost);
    if (sourceCost !== null && sourceCost < 0) reasons.push("source_cost_invalid");
    if (shippingCost !== null && shippingCost < 0) reasons.push("shipping_cost_invalid");

    const sourceCurrency = typeof listing.currency === "string" && listing.currency.trim() ? listing.currency.trim().toUpperCase() : null;
    const metadataFxRate = num(metadata.fx_rate);
    const sourceFxRateToSelling = resolveSupplierFxRateToJpy({
      sourceCurrency,
      metadataFxRate,
      metadataFxSourceCurrency: typeof metadata.fx_rate_source_currency === "string" ? metadata.fx_rate_source_currency : typeof metadata.source_currency === "string" ? metadata.source_currency : null,
      metadataFxTargetCurrency: typeof metadata.fx_rate_target_currency === "string" ? metadata.fx_rate_target_currency : null,
      observedUsdToJpyRate: observedFx?.rate ?? null,
    });
    const sourceFxRateSource = sourceCurrency === "JPY" ? "same_currency" : metadataFxRate !== null && (sourceCurrency === "USD" || String(metadata.fx_rate_source_currency ?? metadata.source_currency ?? "").trim().toUpperCase() === sourceCurrency) ? "supplier_listing_metadata" : (sourceCurrency === "USD" ? observedFx?.source ?? null : null);
    // A missing freight quote can inform a price simulation, but it is not
    // evidence. Do not publish that simulation as a known landed cost.
    const shippingAllowanceUsd = resolveUnknownShippingAllowanceUsd(process.env.TRACER_CJ_UNKNOWN_SHIPPING_ALLOWANCE_USD);
    const shippingEstimated = shippingCost === null && String(listing.supplier ?? "").trim().toLowerCase() === "cj" && /^[0-9]{10,22}$/.test(String(listing.supplier_product_id ?? "")) && /^[0-9]{10,22}$/.test(String(listing.supplier_variant_id ?? "")) && listing.orderable === true && sourceCurrency === "USD";
    const supplierShippingKnown = shippingCost !== null && Number.isFinite(shippingCost) && shippingCost >= 0;
    // The configured allowance is a pricing assumption, not a supplier quote. The price/profit gate below evaluates the allowance without treating estimation itself as a rejection.
    const pricingShippingCost = shippingCost ?? (shippingEstimated ? shippingAllowanceUsd : null);
    sellingPrice = calculateSupplySellingPriceJpy({
      existingSellingPriceJpy: shippingEstimated ? null : sellingPrice,
      sourceCost,
      shippingCost: pricingShippingCost,
      sourceFxRateToSelling,
      platformFeeRate: PROFIT_ASSUMPTIONS.platform_fee_rate,
      paymentFeeRate: PROFIT_ASSUMPTIONS.payment_fee_rate,
      advertisingAllowanceRate: PROFIT_ASSUMPTIONS.advertising_allowance_rate,
      returnRefundReserveRate: PROFIT_ASSUMPTIONS.return_refund_reserve_rate,
      fxReserveRate: PROFIT_ASSUMPTIONS.fx_reserve_rate,
      targetContributionMargin: 0.50,
    });
    if (sellingPrice === null || sellingPrice <= 0) reasons.push("selling_price_unknown");
    const profit = simulateContributionProfit({
      sellingPrice,
      sellingCurrency: "JPY",
      sellingProvider: "tracer_supply",
      sourceCost,
      sourceCurrency,
      sourceProvider: String(listing.supplier ?? "unknown"),
      internationalShipping: pricingShippingCost,
      // CJ freight is quoted for direct delivery to the Japanese customer; there is no separate seller-paid domestic leg.
      // Other supplier routes remain blocked until their domestic delivery cost is known.
      domesticShipping: nativeCjSupplyIdentity ? 0 : null,
      requireDomesticShipping: !nativeCjSupplyIdentity,
      shippingCurrency: sourceCurrency,
      sourceFxRateToSelling,
      sourceFxRateSource: sourceFxRateSource ?? undefined,
    });
    const gate = evaluateSalesTestGate({ rank: null, title: localizedTitle, sellingPrice, identityLinked: supplierVerifiedIdentity || (listing.identity_status === "linked" && identifierGradeMethods.has(identityMethod)), identityMethod, identityConfidence: nativeCjSupplyIdentity ? 1 : num(listing.identity_confidence), sourceCost, shippingCost: pricingShippingCost, trackingAvailable: listing.tracking_available === true, apiAvailable: listing.api_available === true, profitCalculable: profit.calculable, shippingUnknown: profit.shippingUnknown, contributionProfit: profit.contributionProfit, currencyMismatch: false, priceConfirmed: listing.price_confirmed === true, inventoryConfirmed: listing.inventory_confirmed === true, inventory: num(listing.inventory), orderable: listing.orderable === true, supplierProductId: typeof listing.supplier_product_id === "string" ? listing.supplier_product_id : null, supplierVariantId: typeof listing.supplier_variant_id === "string" ? listing.supplier_variant_id : null, requireRank: false });
    if (!gate.eligible) reasons.push(...gate.reasons);
    // Demand and AI quality scores prioritize the queue. Publication still
    // requires Japanese copy, a real image, exact supplier product and variant
    // evidence, current stock, and a positive landed profit. A marketplace
    // product id is not required for a verified supplier listing.
    if (reasons.length) { rejected.push({ productId, reasons: Array.from(new Set(reasons)), title: sourceTitle, masterTitle, category: metadataCategory(base.metadata), supplier: String(listing.supplier ?? "unknown"), categoryPriority: womenPriority.categoryPriority, sellingPrice, sourceCost, internationalShipping: shippingCost, domesticShippingKnown: nativeCjSupplyIdentity, contributionProfit: profit.contributionProfit, contributionMargin: profit.contributionMargin }); continue; }

    const womenBonus = womenProductPriority({ title: typeof base.normalized_title === "string" ? base.normalized_title : "", category: typeof metadata.category === "string" ? metadata.category : null }).bonus;
    const quality = (num(intelligence.selection_score) ?? 0) * 0.45 + (num(intelligence.demand_score) ?? 0) * 0.2 + (num(intelligence.search_fit_score) ?? 0) * 0.1 + (num(intelligence.market_gap_score) ?? 0) * 0.1 + (num(intelligence.competition_score) ?? 0) * 0.05 + (num(intelligence.creative_score) ?? 0) * 0.05 + (num(intelligence.overall_confidence) ?? 0) * 100 * 0.05 + womenBonus;
    eligible.push({ productId, listing, base, intelligence, profit, quality, description: publishableDescription!, shippingAllowanceUsd, imageUrl: productImageUrl! });
  }

  eligible.sort((a, b) => {
    const metadataA = a.base.metadata && typeof a.base.metadata === "object" && !Array.isArray(a.base.metadata) ? a.base.metadata as Record<string, unknown> : {};
    const metadataB = b.base.metadata && typeof b.base.metadata === "object" && !Array.isArray(b.base.metadata) ? b.base.metadata as Record<string, unknown> : {};
    const womenA = womenProductPriority({
      title: typeof a.base.normalized_title === "string" ? a.base.normalized_title : "",
      category: typeof metadataA.category === "string" ? metadataA.category : null,
      query: typeof metadataA.query === "string" ? metadataA.query : null,
    });
    const womenB = womenProductPriority({
      title: typeof b.base.normalized_title === "string" ? b.base.normalized_title : "",
      category: typeof metadataB.category === "string" ? metadataB.category : null,
      query: typeof metadataB.query === "string" ? metadataB.query : null,
    });
    if (womenB.bonus !== womenA.bonus) return womenB.bonus - womenA.bonus;
    return b.quality - a.quality;
  });
  const rejectedSamples = rejected.slice(0, 50);
  if (options.dryRun) return {
    published: 0,
    publishedListingIds: [],
    selectedListingIds: [],
    considered: uniqueProductIds.length,
    rejectedCount: rejected.length,
    rejectionCounts: summarizeRejections(rejected),
    rejected: rejectedSamples,
    eligibleProductIds: eligible.map((item) => item.productId),
    eligibleSamples: eligible.slice(0, 50).map((item) => ({
      productId: item.productId,
      title: String(item.listing.title ?? item.base.normalized_title ?? ""),
      localizedTitle: localizeProductTitle(String(item.listing.title ?? item.base.normalized_title ?? ""), metadataCategory(item.base.metadata)),
      titleQualityPass: isPublishableCatalogTitle(localizeProductTitle(String(item.listing.title ?? item.base.normalized_title ?? ""), metadataCategory(item.base.metadata))),
      description: item.description,
      category: metadataCategory(item.base.metadata),
      supplier: String(item.listing.supplier ?? ""),
      supplierProductId: item.listing.supplier_product_id ?? null,
      supplierVariantId: item.listing.supplier_variant_id ?? null,
      sellingPriceJpy: item.profit.sellingPrice,
      sourceCost: item.profit.sourceCost,
      shippingCost: item.profit.internationalShipping,
      inventory: num(item.listing.inventory),
      contributionProfit: item.profit.contributionProfit,
      contributionMargin: item.profit.contributionMargin,
      identityMethod: item.listing.identity_method ?? null,
      verificationStatus: item.listing.verification_status ?? null,
      shippingStatus: item.listing.shipping_status ?? null,
      priceConfirmed: item.listing.price_confirmed === true,
      inventoryConfirmed: item.listing.inventory_confirmed === true,
      orderable: item.listing.orderable === true,
      trackingAvailable: item.listing.tracking_available === true,
      apiAvailable: item.listing.api_available === true,
    })),
  };
  const eligibleProductIds = eligible.map((item) => item.productId);
  const { data: liveListings, error: liveListingsError } = await supabase.from("shop_listings").select("product_id").in("product_id", eligibleProductIds).eq("published", true).in("pipeline_status", ["published"]);
  if (liveListingsError) throw new Error(liveListingsError.message);
  const liveProductIds = new Set((liveListings ?? []).map((row) => String(row.product_id ?? "")).filter(Boolean));
  const chosen = eligible.filter((item) => !liveProductIds.has(item.productId)).slice(0, limit); const publishedListingIds: string[] = []; const selectedListingIds: string[] = [];
  for (const item of chosen) {
    const title = localizeProductTitle(String(item.listing.title ?? item.base.normalized_title ?? ""), metadataCategory(item.base.metadata)) ?? "";
    // Final fail-closed guard: generated fallback names must not bypass the
    // same buyer-facing catalog quality gate used during candidate selection.
    if (!isPublishableCatalogTitle(title)) {
      rejected.push({ productId: item.productId, reasons: ["catalog_title_not_publishable"], title, supplier: String(item.listing.supplier ?? "unknown") });
      continue;
    }
    if (!isPublishableCatalogDescription(item.description)) {
      rejected.push({ productId: item.productId, reasons: ["japanese_description_unavailable"], title, supplier: String(item.listing.supplier ?? "unknown") });
      continue;
    }
    const slug = slugify(title, item.productId); const now = new Date().toISOString();
    const metadata = item.base.metadata && typeof item.base.metadata === "object" && !Array.isArray(item.base.metadata) ? item.base.metadata as Record<string, unknown> : {};
    const payload = { product_id: item.productId, bestseller_id: null, supplier_listing_id: item.listing.id, slug, title, description: item.description.slice(0, 700), image_url: item.imageUrl, selling_price: item.profit.sellingPrice, currency: "JPY", supplier_name: String(item.listing.supplier ?? "unknown"), supplier_product_id: item.listing.supplier_product_id, supplier_variant_id: item.listing.supplier_variant_id, source_cost: item.profit.sourceCost, shipping_cost: persistedListingShippingCost({ supplierShippingCost: num(item.listing.shipping_cost), convertedInternationalShipping: item.profit.internationalShipping }), inventory: num(item.listing.inventory), orderable: item.listing.orderable === true, tracking_available: item.listing.tracking_available === true, identity_method: isNativeCjSupplierListing(item.listing) ? "cj_supplier_variant" : (typeof item.listing.identity_method === "string" ? item.listing.identity_method : null), identity_confidence: isNativeCjSupplierListing(item.listing) ? 1 : num(item.listing.identity_confidence), contribution_profit: item.profit.contributionProfit, contribution_margin: item.profit.contributionMargin, published: true, selection_reasons: [SALES_TEST_GATE_PASSED, "sales_test_gate:supply", "supply_intelligence_gate_passed", "selection_score_" + (num(item.intelligence.selection_score)?.toFixed(1) ?? "0")], missing: [], published_at: now, pipeline_stage: "PUBLISHED", pipeline_status: "published", pipeline_reason: SALES_TEST_GATE_PASSED, pipeline_error: null, pipeline_updated_at: now, updated_at: now };
    const existing = await supabase.from("shop_listings").select("id, archived_at").eq("slug", slug).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    // Archived listing history is immutable: do not reuse it for a new publish candidate.
    if (existing.data?.archived_at) continue;
    let existingId = existing.data?.id ? String(existing.data.id) : null; let keepSlug = false;
    if (!existingId) { const byProduct = await supabase.from("shop_listings").select("id, archived_at").eq("product_id", item.productId).is("archived_at", null).order("updated_at", { ascending: false }).limit(1).maybeSingle(); if (byProduct.error) throw new Error(byProduct.error.message); if (byProduct.data?.archived_at) continue; if (byProduct.data?.id) { existingId = String(byProduct.data.id); keepSlug = true; } }
    const { slug: _slug, ...payloadWithoutSlug } = payload; void _slug;
    const result = existingId ? await supabase.from("shop_listings").update(keepSlug ? payloadWithoutSlug : payload).eq("id", existingId).select("id").single() : await supabase.from("shop_listings").insert(payload).select("id").single();
    if (result.error) throw new Error(result.error.message);
    if (result.data?.id) { const listingId = String(result.data.id); selectedListingIds.push(listingId); publishedListingIds.push(listingId); }
  }
  return { published: publishedListingIds.length, publishedListingIds, selectedListingIds, considered: uniqueProductIds.length, rejectedCount: rejected.length, rejectionCounts: summarizeRejections(rejected), rejected: rejectedSamples };
}
