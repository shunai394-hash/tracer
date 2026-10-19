import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { persistCjSupplyIntelligence, resolveMarketplaceIdentityWithFreshBarcode } from "@/lib/intelligence/persist-cj-supply-intelligence";
import { calculateCJFreight, fetchCJVariantByVid, fetchCJVariantStock, getCJProductDetail } from "@/lib/sources/cj";
import { isCJQuotaCircuitBlockingError, isCJQuotaExhaustedError } from "@/lib/sources/cj/client";
import { getCJQuotaCooldownUntil, isCJQuotaCircuitActive } from "@/lib/sources/cj/rate-limit-policy";
import { getObservedUsdToJpyRate } from "@/lib/intelligence/fx";
import { normalizeIdentifier } from "@/lib/market/identifiers";
import { isCjIdentityReverifyCandidate, isCjIdentityReverifyDue, CJ_IDENTITY_RETRY_DELAYS_MS, supplierBarcodeAudit, partitionByExactShopListing } from "@/lib/suppliers/cj-identity-reverify-policy";

const CURSOR_JOB = "cj-identity-reverify-cursor";
const QUOTA_CIRCUIT_JOB = "cj-api-quota-circuit";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_CANDIDATE_SCAN = 500;
// CJ enforces a strict 1-request/second API quota; parallel variant lookups
// trigger HTTP 429s and consume the bounded patrol deadline. Process one listing
// at a time so retries/cursor progress remain deterministic.
const CONCURRENCY = 1;
const NO_MATCH_RETRY_MS = CJ_IDENTITY_RETRY_DELAYS_MS.noUniqueMatch;
const MISSING_DATA_RETRY_MS = CJ_IDENTITY_RETRY_DELAYS_MS.missingEvidence;
const ERROR_RETRY_MS = CJ_IDENTITY_RETRY_DELAYS_MS.processingError;
const SHIPPING_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INVENTORY_EVIDENCE_MAX_AGE_MS = 30 * 60 * 1000;
const MISSING_TIMESTAMP_RETRY_MS = 30 * 60 * 1000;
const WOMENS_PRODUCT_PATTERNS = [
  /skincare|skin care|serum|moisturizer|moisturiser|face cream|sunscreen|toner|essence|retinol|niacinamide|acne patch|pore strip|facial mask|cleansing/i,
  /beauty|cosmetic case|cosmetic bag|makeup|lipstick|lip gloss|lip tint|blush|mascara|eyelash|eyeliner|highlighter|contour|concealer/i,
  /gua sha|face roller|led beauty mask|cleansing brush|makeup brush|beauty device|nail lamp|nail drill|nail art|manicure|pedicure/i,
  /hair care|haircare|hair brush|scalp massager|hair oil|heatless curls|hair dryer|hair curler|curling iron|hair straightener|hair clip|hair claw|hair removal/i,
  /women'?s (?:dress|clothing|fashion|bag|shoes|accessory)|womens (?:dress|clothing|fashion|bag|shoes|accessory)|women|women'?s|womens|ladies|female|sports bra|bralette|shapewear/i,
  /handbag|crossbody bag|tote bag|jewelry|earrings?|necklace|bracelet|hair accessory|anklet|ring jewelry/i,
  /period|menstrual|menstrual cup|period underwear|ovulation|pregnancy test|pelvic floor|intimate care/i,
  /bra organizer|makeup organizer|cosmetic bag|jewelry organizer|closet organizer|shoe organizer|portable garment steamer/i,
  /beauty storage|vanity organizer|cosmetic storage|purse organizer|underwear organizer|lingerie/i,
];
function isWomensProductTitle(title: unknown, metadata?: unknown): boolean {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
  const searchable = [typeof title === "string" ? title : "", typeof record.category === "string" ? record.category : "", typeof record.query === "string" ? record.query : "", typeof record.tags === "string" ? record.tags : "", Array.isArray(record.tags) ? record.tags.filter((value): value is string => typeof value === "string").join(" ") : ""].join(" ");
  return WOMENS_PRODUCT_PATTERNS.some((pattern) => pattern.test(searchable));
}
export type CjIdentityProgressCounts = {
  linkedCjSupplierListings: number;
  saleableCatalogProducts: number;
  linkedInStockCatalogVariants: number;
  publishedOrderableListings: number;
};
export type CjIdentityReverifyResult = { checked: number; promoted: number; supplierVerified: number; noUniqueBarcodeMatch: number; missingEconomics: number; remediationQueued: Array<{ supplierListingId: string; missingFields: string[]; nextActions: string[] }>; errors: Array<{ supplierListingId: string; error: string }>; promotedListings: Array<{ supplierListingId: string; bestsellerId: string; method: string }>; nextCursor: string | null; quotaBlockedUntil: string | null; progress: { before: CjIdentityProgressCounts; after: CjIdentityProgressCounts } };

async function readCjIdentityProgressCounts(db: ReturnType<typeof createSupabaseAdminClient>): Promise<CjIdentityProgressCounts> {
  const [linked, products, variants, published] = await Promise.all([
    db.from("supplier_listings").select("id", { count: "exact", head: true }).eq("supplier", "cj").eq("identity_status", "linked"),
    db.from("tracer_supply_catalog").select("id", { count: "exact", head: true }).eq("status", "ready").eq("orderable", true).gt("inventory", 0),
    db.from("tracer_supply_variants").select("id", { count: "exact", head: true }).not("internal_supply_variant_id", "is", null).eq("orderable", true).gt("inventory", 0),
    db.from("shop_listings").select("id", { count: "exact", head: true }).eq("published", true).eq("orderable", true),
  ]);
  const failed = [linked, products, variants, published].find((query) => query.error);
  if (failed?.error) throw new Error("CJ identity progress audit failed: " + failed.error.message);
  return {
    linkedCjSupplierListings: linked.count ?? 0,
    saleableCatalogProducts: products.count ?? 0,
    linkedInStockCatalogVariants: variants.count ?? 0,
    publishedOrderableListings: published.count ?? 0,
  };
}
function num(value: unknown): number | null { const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN; return Number.isFinite(parsed) ? parsed : null; }
function hasFreshEvidenceTimestamp(value: unknown, maxAgeMs: number, nowMs: number): boolean { const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN; return Number.isFinite(timestamp) && timestamp <= nowMs && nowMs - timestamp <= maxAgeMs; }
function evidenceTimestampRepairDue(row: { shipping_cost: unknown; shipping_status: unknown; shipping_checked_at: unknown; inventory: unknown; inventory_confirmed: unknown; inventory_checked_at: unknown; metadata: unknown }, nowMs: number): boolean {
  const shippingTimestampMissing = row.shipping_cost !== null && row.shipping_cost !== undefined && row.shipping_status === "verified" && !hasFreshEvidenceTimestamp(row.shipping_checked_at, SHIPPING_EVIDENCE_MAX_AGE_MS, nowMs);
  const inventoryTimestampMissing = row.inventory !== null && row.inventory !== undefined && row.inventory_confirmed === true && !hasFreshEvidenceTimestamp(row.inventory_checked_at, INVENTORY_EVIDENCE_MAX_AGE_MS, nowMs);
  if (!shippingTimestampMissing && !inventoryTimestampMissing) return false;
  const lastAttempt = Date.parse(String(record(row.metadata).last_identity_reverify_at ?? ""));
  return !Number.isFinite(lastAttempt) || nowMs - lastAttempt >= MISSING_TIMESTAMP_RETRY_MS;
}
function isHttpUrl(value: unknown): value is string { return typeof value === "string" && (value.trim().startsWith("https://") || value.trim().startsWith("http://")); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

export async function reverifyCjSupplyIdentities(options: { limit?: number; deadlineAt?: number; force?: boolean; supplierListingIds?: string[] } = {}): Promise<CjIdentityReverifyResult> {
  const db = createSupabaseAdminClient();
  const { data: quotaRuns, error: quotaReadError } = await db
    .from("cron_runs")
    .select("metadata")
    .eq("job_name", QUOTA_CIRCUIT_JOB)
    .order("started_at", { ascending: false })
    .limit(1);
  if (quotaReadError) throw new Error(`CJ quota circuit read failed: ${quotaReadError.message}`);
  const blockedUntilValue = record(quotaRuns?.[0]?.metadata).blockedUntil;
  const blockedUntil = typeof blockedUntilValue === "string" ? blockedUntilValue : null;
  if (isCJQuotaCircuitActive(quotaRuns?.[0]?.metadata)) {
    const progress = await readCjIdentityProgressCounts(db);
    return {
      checked: 0,
      promoted: 0,
      supplierVerified: 0,
      noUniqueBarcodeMatch: 0,
      missingEconomics: 0,
      remediationQueued: [],
      errors: [{ supplierListingId: "system", error: "CJ_API_QUOTA_EXHAUSTED_COOLDOWN" }],
      promotedListings: [],
      nextCursor: null,
      quotaBlockedUntil: blockedUntil,
      progress: { before: progress, after: progress },
    };
  }
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const force = options.force === true;
  const targetSupplierListingIds = [...new Set((options.supplierListingIds ?? [])
    .map((value) => String(value).trim())
    .filter((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)))]
    .slice(0, 10);
  const deadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY;
  const candidateFilter = db.from("supplier_listings").select("id", { count: "exact", head: true }).eq("supplier", "cj").in("verification_status", ["unverified", "retryable", "verified"]).in("identity_method", ["supply_discovered", "none", "cj_supplier_variant"]).not("supplier_variant_id", "is", null);
  const { count: candidateCount, error: countError } = await candidateFilter;
  if (countError) throw new Error(`identity reverify candidate count failed: ${countError.message}`);
  const total = candidateCount ?? 0;
  // Prioritize only the explicit stock-cap deployment hold after the cap is confirmed.
  // This bypasses that row's barcode-related retry backoff, not the API quota or evidence gates.
  const stockCapHeldResult = targetSupplierListingIds.length === 0 && process.env.TRACER_STOREFRONT_STOCK_CAP_DEPLOYED === "1"
    ? await db.from("supplier_listings")
        .select("id,product_id,title,sku,cost,shipping_cost,shipping_status,shipping_checked_at,inventory,inventory_checked_at,supplier_product_id,supplier_variant_id,identity_method,metadata,gtin,jan,ean,upc,mpn,verification_status,currency,price_confirmed,inventory_confirmed,configured,api_available,orderable,tracking_available,ship_to,verification_error")
        .eq("supplier", "cj")
        .eq("verification_error", "storefront_stock_cap_deploy_pending")
        .in("verification_status", ["unverified", "retryable", "verified"])
        .in("identity_method", ["supply_discovered", "none", "cj_supplier_variant"])
        .not("supplier_variant_id", "is", null)
        .order("last_verified_at", { ascending: true })
        .limit(limit)
    : { data: [], error: null };
  if (stockCapHeldResult.error) throw new Error(`stock-cap held CJ identity read failed: ${stockCapHeldResult.error.message}`);
  const stockCapHeldRows = stockCapHeldResult.data ?? [];
  const stockCapHoldIds = new Set(stockCapHeldRows.map((row) => String(row.id)));

  const { data: priorRuns, error: priorRunsError } = await db
    .from("cron_runs")
    .select("metadata")
    .eq("job_name", CURSOR_JOB)
    .eq("status", "succeeded")
    .order("started_at", { ascending: false })
    .limit(1);
  if (priorRunsError) throw new Error(`identity reverify cursor read failed: ${priorRunsError.message}`);
  const priorCursor = typeof record(priorRuns?.[0]?.metadata).nextCursor === "string"
    ? String(record(priorRuns?.[0]?.metadata).nextCursor)
    : null;

  const buildCandidateQuery = () => db
    .from("supplier_listings")
    .select("id,product_id,title,sku,cost,shipping_cost,shipping_status,shipping_checked_at,inventory,inventory_checked_at,supplier_product_id,supplier_variant_id,identity_method,metadata,gtin,jan,ean,upc,mpn,verification_status,currency,price_confirmed,inventory_confirmed,configured,api_available,orderable,tracking_available,ship_to,verification_error")
    .eq("supplier", "cj")
    .in("verification_status", ["unverified", "retryable", "verified"])
    .in("identity_method", ["supply_discovered", "none", "cj_supplier_variant"])
    .not("supplier_variant_id", "is", null)
    .order("id", { ascending: true })
    .limit(MAX_CANDIDATE_SCAN);

  let rowsResult = targetSupplierListingIds.length > 0
    ? await buildCandidateQuery().in("id", targetSupplierListingIds).limit(targetSupplierListingIds.length)
    : priorCursor
      ? await buildCandidateQuery().gt("id", priorCursor)
      : await buildCandidateQuery();
  if (rowsResult.error) throw new Error(`identity reverify candidate query failed: ${rowsResult.error.message}`);

  // Scan a bounded page after the cursor. If the cursor is at the end of the
  // eligible set, wrap to the first page; never fetch the whole supplier table.
  if (targetSupplierListingIds.length === 0 && (rowsResult.data ?? []).length === 0 && priorCursor) {
    rowsResult = await buildCandidateQuery();
    if (rowsResult.error) throw new Error(`identity reverify candidate wrap query failed: ${rowsResult.error.message}`);
  }

  const scanRows = rowsResult.data ?? [];
  const rowsById = new Map<string, (typeof scanRows)[number]>();
  for (const row of stockCapHeldRows) rowsById.set(String(row.id), row as (typeof scanRows)[number]);
  for (const row of scanRows) rowsById.set(String(row.id), row);
  const rows = [...rowsById.values()];
  const nowMs = Date.now();
  // Force bypasses only the per-row identity retry backoff. The exact stock-cap
  // hold is also due immediately after the explicit deployment flag is set.
  // The CJ API quota circuit and all supplier-evidence gates remain enforced.
  const allRows = rows.filter((row) => {
    const eligible = isCjIdentityReverifyCandidate({
      verificationStatus: row.verification_status,
      identityMethod: row.identity_method,
      supplierVariantId: row.supplier_variant_id,
    }) && (force || stockCapHoldIds.has(String(row.id)) || isCjIdentityReverifyDue(row.metadata, nowMs) || evidenceTimestampRepairDue(row, nowMs));
    // CJ product and variant endpoints require numeric IDs. UUIDs restored from
    // backups are internal placeholders, not CJ identifiers; skip them so they
    // cannot consume the provider quota needed to verify real products.
    const validCjIds = /^\d{10,25}$/.test(String(row.supplier_product_id ?? ""))
      && /^\d{10,25}$/.test(String(row.supplier_variant_id ?? ""));
    return eligible && validCjIds;
  });
  const stockCapHeld = allRows.filter((row) => stockCapHoldIds.has(String(row.id)));
  const regularRows = allRows.filter((row) => !stockCapHoldIds.has(String(row.id)));
  const productIds = [...new Set(regularRows.map((row) => String(row.product_id ?? "").trim()).filter(Boolean))];
  const shopEvidenceResult = productIds.length > 0
    ? await db.from("shop_listings")
        .select("product_id,supplier_listing_id,supplier_name,supplier_product_id,supplier_variant_id")
        .eq("supplier_name", "cj")
        .in("product_id", productIds)
        .limit(500)
    : { data: [], error: null };
  if (shopEvidenceResult.error) throw new Error("exact TRACER shop-listing evidence read failed: " + shopEvidenceResult.error.message);
  const shopEvidence = (shopEvidenceResult.data ?? []).filter((listing) =>
    (typeof listing.supplier_listing_id === "string" && listing.supplier_listing_id.trim().length > 0)
    || (typeof listing.supplier_product_id === "string" && typeof listing.supplier_variant_id === "string")
  );
  const partition = partitionByExactShopListing(regularRows, shopEvidence);
  const matchedWomens = partition.matched.filter((row) => isWomensProductTitle(row.title, row.metadata));
  const matchedOther = partition.matched.filter((row) => !isWomensProductTitle(row.title, row.metadata));
  const unmatchedWomens = partition.unmatched.filter((row) => isWomensProductTitle(row.title, row.metadata));
  const unmatchedOther = partition.unmatched.filter((row) => !isWomensProductTitle(row.title, row.metadata));
  const priority = (row: typeof allRows[number]) => row.verification_status === "unverified" ? 0 : 1;
  stockCapHeld.sort((a, b) => priority(a) - priority(b) || String(a.id).localeCompare(String(b.id)));
  for (const group of [matchedWomens, matchedOther, unmatchedWomens, unmatchedOther]) {
    group.sort((a, b) => priority(a) - priority(b) || String(a.id).localeCompare(String(b.id)));
  }
  // Revalidate supplier rows that already back a TRACER listing first. Within
  // that group, retain the existing women's-product priority. Supplier-only
  // rows follow, so they cannot consume the initial recovery batches.
  const prioritizedRegularRows = [...matchedWomens, ...matchedOther, ...unmatchedWomens, ...unmatchedOther];
  const beforeCounts = await readCjIdentityProgressCounts(db);
  // The cursor is an ID cursor, so rows must be processed in ascending ID order.
  // The previous priority-group selection could process low IDs after high IDs,
  // while advancing the cursor to the end of the full scan and repeatedly retrying
  // the same first batch. Keep the bounded batch cursor-safe; prioritize on later
  // batches by continuing from the last completed ID.
  const boundedRows = allRows
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .slice(0, limit);
  const boundedIds = new Set(boundedRows.map((row) => String(row.id)));
  // Keep the cursor-safe ID window intact, but process its exact shop-listing
  // matches first. Every row in the window is still processed unless provider
  // quota/circuit protection stops the batch (in which case the cursor is kept).
  const selectedRows = [
    ...stockCapHeld.filter((row) => boundedIds.has(String(row.id))),
    ...prioritizedRegularRows.filter((row) => boundedIds.has(String(row.id))),
  ];
  const womensRows = [...matchedWomens, ...unmatchedWomens];
  const result: CjIdentityReverifyResult = { checked: 0, promoted: 0, supplierVerified: 0, noUniqueBarcodeMatch: 0, missingEconomics: 0, remediationQueued: [], errors: [], promotedListings: [], nextCursor: priorCursor, quotaBlockedUntil: null, progress: { before: beforeCounts, after: beforeCounts } };
  const processRow = async (row: NonNullable<typeof rows>[number]) => {
    const supplierListingId = String(row.id);
    try {
      const listingMetadata = record(row.metadata);
      const { identity, variantBarcode, variantDetails: freshVariantDetails } = await resolveMarketplaceIdentityWithFreshBarcode({
        db,
        supplierProductId: String(row.supplier_product_id),
        supplierVariantId: String(row.supplier_variant_id),
        variantBarcode: typeof listingMetadata.variant_barcode === "string" ? listingMetadata.variant_barcode.trim() : null,
        supplierIdentifiers: { gtin: row.gtin, jan: row.jan, ean: row.ean, upc: row.upc, mpn: row.mpn },
      });
      const canonicalProductId = identity?.productId ?? String(row.product_id);
      if (!canonicalProductId) { await db.from("supplier_listings").update({ metadata: { ...listingMetadata, ...(variantBarcode ? { variant_barcode: variantBarcode } : {}), last_identity_reverify_at: new Date().toISOString() } }).eq("id", supplierListingId); return { kind: "no_match" as const, supplierListingId }; }
      const { data: intelligence } = await db.from("product_intelligence").select("image_url,metadata").eq("product_id", canonicalProductId).maybeSingle();
      const metadata = record(intelligence?.metadata);
      let cost = num(row.cost);
      let shippingCost = num(row.shipping_cost);
      let inventory = num(row.inventory);
      let imageUrl = isHttpUrl(intelligence?.image_url) ? intelligence.image_url.trim() : "";
      if (!imageUrl) {
        const listingImage = [listingMetadata.image_url, listingMetadata.product_image, listingMetadata.productImage, listingMetadata.image].find(isHttpUrl);
        imageUrl = typeof listingImage === "string" ? listingImage.trim() : "";
      }

      // Recover missing evidence from the exact CJ product/variant instead of
      // recording a generic hold and waiting for the next patrol.
      const currency = String(row.currency ?? metadata.currency ?? metadata.source_currency ?? "").trim().toUpperCase();
      let priceVerified = cost !== null && row.price_confirmed === true;
      let inventoryVerified = inventory !== null && row.inventory_confirmed === true && hasFreshEvidenceTimestamp(row.inventory_checked_at, INVENTORY_EVIDENCE_MAX_AGE_MS, nowMs);
      const missingCost = !priceVerified;
      const missingShipping = shippingCost === null || row.shipping_status !== "verified" || !hasFreshEvidenceTimestamp(row.shipping_checked_at, SHIPPING_EVIDENCE_MAX_AGE_MS, nowMs);
      const missingInventory = !inventoryVerified;
      const missingImage = !imageUrl;
      let shippingQuoteVerified = row.shipping_status === "verified" && shippingCost !== null && hasFreshEvidenceTimestamp(row.shipping_checked_at, SHIPPING_EVIDENCE_MAX_AGE_MS, nowMs);
      let shippingRefreshedLive = false;
      let inventoryRefreshedLive = false;
      let variantDetails: Awaited<ReturnType<typeof fetchCJVariantByVid>> = freshVariantDetails;
      // The live CJ variant endpoint is authoritative for the parent product ID.
      // Backup-restored listings can have a stale product ID even when the VID is valid.
      let liveCanonicalSupplierProductId = String(row.supplier_product_id);
      let productDetails: Awaited<ReturnType<typeof getCJProductDetail>> = null;
      const refreshErrors: string[] = [];
      let liveSupplierApiVerified = row.api_available === true && row.configured === true;

      if (missingCost && currency === "USD") {
        try {
          variantDetails = variantDetails ?? await fetchCJVariantByVid(String(row.supplier_variant_id));
          const exactVariant = variantDetails?.vid === String(row.supplier_variant_id)
            && /^\d{10,25}$/.test(String(variantDetails?.productId ?? ""));
          const fetchedCost = exactVariant ? num(variantDetails?.sellPrice) : null;
          if (exactVariant && variantDetails?.productId) {
            // Accept the product ID returned by CJ only after the requested VID
            // exactly matches the live response; preserve an audit trail below.
            liveCanonicalSupplierProductId = variantDetails.productId;
          }
          if (fetchedCost !== null && fetchedCost > 0) {
            cost = fetchedCost;
            priceVerified = true;
            liveSupplierApiVerified = true;
          } else if (!exactVariant) refreshErrors.push("cost:returned_variant_id_or_product_id_invalid");
        } catch (error) {
          if (isCJQuotaCircuitBlockingError(error)) throw error;
          refreshErrors.push("cost:" + (error instanceof Error ? error.message : String(error)));
        }
      }
      if (missingShipping && currency === "USD") {
        try {
          const fetchedShipping = await calculateCJFreight(String(row.supplier_variant_id), { startCountryCode: "CN", endCountryCode: "JP", quantity: 1 });
          if (fetchedShipping !== null && Number.isFinite(fetchedShipping) && fetchedShipping >= 0) {
            shippingCost = fetchedShipping;
            shippingQuoteVerified = true;
            shippingRefreshedLive = true;
            liveSupplierApiVerified = true;
          }
        } catch (error) {
          if (isCJQuotaCircuitBlockingError(error)) throw error;
          refreshErrors.push("shipping:" + (error instanceof Error ? error.message : String(error)));
        }
      }
      if (missingInventory) {
        try {
          const fetchedInventory = await fetchCJVariantStock(String(row.supplier_variant_id));
          if (fetchedInventory !== null && Number.isFinite(fetchedInventory) && fetchedInventory >= 0) {
            inventory = fetchedInventory;
            inventoryVerified = true;
            inventoryRefreshedLive = true;
            liveSupplierApiVerified = true;
          }
        } catch (error) {
          if (isCJQuotaCircuitBlockingError(error)) throw error;
          refreshErrors.push("inventory:" + (error instanceof Error ? error.message : String(error)));
        }
      }
      if (missingImage) {
        try {
          productDetails = await getCJProductDetail(liveCanonicalSupplierProductId);
          if (productDetails?.id === liveCanonicalSupplierProductId && isHttpUrl(productDetails.imageUrl)) {
            imageUrl = productDetails.imageUrl.trim();
            liveSupplierApiVerified = true;
          }
          else if (productDetails && productDetails.id !== liveCanonicalSupplierProductId) refreshErrors.push("image:returned_product_id_mismatch");
        } catch (error) {
          if (isCJQuotaCircuitBlockingError(error)) throw error;
          refreshErrors.push("image:" + (error instanceof Error ? error.message : String(error)));
        }
      }

      const storedFxRate = num(metadata.fx_rate);
      const observedFx = storedFxRate === null && currency === "USD" ? await getObservedUsdToJpyRate() : null;
      const fxRate = storedFxRate ?? observedFx?.rate ?? null;
      const storedSellingPriceJpy = num(metadata.selling_price_jpy);
      const landedCostJpy = cost !== null && shippingCost !== null && shippingQuoteVerified && fxRate !== null ? (cost + shippingCost) * fxRate : null;
      const sellingPriceJpy = storedSellingPriceJpy ?? (landedCostJpy !== null && Number.isFinite(landedCostJpy) && landedCostJpy >= 0 ? Math.ceil(Math.max(1980, landedCostJpy * 2.5) / 100) * 100 : null);

      const checkedAt = new Date();
      const legacyParentIdMismatch = Array.isArray(listingMetadata.missing_supply_evidence_errors)
        && listingMetadata.missing_supply_evidence_errors.includes("cost:returned_variant_or_product_id_mismatch");
      const nextListingMetadata = {
        ...listingMetadata,
        ...(legacyParentIdMismatch ? {
          missing_supply_evidence_errors: (listingMetadata.missing_supply_evidence_errors as unknown[]).filter((value) => value !== "cost:returned_variant_or_product_id_mismatch"),
          legacy_parent_id_mismatch_retry_attempted_at: checkedAt.toISOString(),
        } : {}),
        ...(variantBarcode ? { variant_barcode: variantBarcode, variant_barcode_raw: variantBarcode } : {}),
        ...(imageUrl ? { image_url: imageUrl } : {}),
        ...(cost !== null ? { recovered_cost_at: missingCost ? checkedAt.toISOString() : listingMetadata.recovered_cost_at } : {}),
        ...(shippingQuoteVerified && shippingCost !== null ? { recovered_shipping_at: missingShipping ? checkedAt.toISOString() : listingMetadata.recovered_shipping_at, shipping_quote_source: "cj_freight_calculate", shipping_quote_destination: "JP" } : {}),
        ...(inventory !== null ? { recovered_inventory_at: missingInventory ? checkedAt.toISOString() : listingMetadata.recovered_inventory_at } : {}),
        ...(productDetails?.imageUrl ? { recovered_image_source: "cj_product_detail" } : {}),
        last_identity_reverify_at: checkedAt.toISOString(),
      };
      const refreshedFields: Record<string, unknown> = { metadata: nextListingMetadata };
      if (liveCanonicalSupplierProductId !== String(row.supplier_product_id)) {
        refreshedFields.supplier_product_id = liveCanonicalSupplierProductId;
        refreshedFields.metadata = {
          ...nextListingMetadata,
          live_cj_product_id_corrected_at: checkedAt.toISOString(),
          live_cj_product_id_previous: String(row.supplier_product_id),
          live_cj_product_id_source: "queryByVid_exact_vid_match",
        };
      }
      if (liveSupplierApiVerified) {
        // Backup restoration intentionally invalidated stale supplier capability
        // flags. Re-enable only the flags proven by successful live CJ reads;
        // never infer that a real order or tracking flow has been tested.
        refreshedFields.configured = true;
        refreshedFields.api_available = true;
      }
      if (priceVerified && cost !== null) {
        refreshedFields.cost = cost;
        refreshedFields.price_confirmed = true;
      }
      if (variantDetails?.vid === String(row.supplier_variant_id)
        && variantDetails.productId === liveCanonicalSupplierProductId
        && typeof variantDetails.sku === "string"
        && variantDetails.sku.trim()) {
        refreshedFields.sku = variantDetails.sku.trim();
      }
      if (shippingQuoteVerified && shippingCost !== null) {
        refreshedFields.shipping_cost = shippingCost;
        refreshedFields.shipping_status = "verified";
        refreshedFields.ship_to = "JP";
        if (shippingRefreshedLive) refreshedFields.shipping_checked_at = checkedAt.toISOString();
      }
      if (inventoryVerified && inventory !== null) {
        refreshedFields.inventory = inventory;
        refreshedFields.inventory_confirmed = true;
        if (inventoryRefreshedLive) refreshedFields.inventory_checked_at = checkedAt.toISOString();
      }
      // A stock-cap deployment hold may only be cleared after the capped storefront-stock
      // implementation is explicitly confirmed in this production environment.
      const stockCapHoldRecoverable =
        row.verification_error === "storefront_stock_cap_deploy_pending"
        && process.env.TRACER_STOREFRONT_STOCK_CAP_DEPLOYED === "1";
      const canMarkFreshVerified = priceVerified && cost !== null && cost > 0
        && shippingQuoteVerified && shippingCost !== null
        && inventoryVerified && inventory !== null && inventory > 0
        && (row.configured === true || liveSupplierApiVerified)
        && (row.api_available === true || liveSupplierApiVerified)
        && (row.orderable === true || stockCapHoldRecoverable) && row.tracking_available === true
        && Boolean(String(row.supplier_product_id ?? "").trim())
        && Boolean(String(row.supplier_variant_id ?? "").trim())
        && String(row.ship_to ?? "").trim().toUpperCase() === "JP"
        && (row.verification_error == null || row.verification_error === "" || stockCapHoldRecoverable
          || row.verification_error === "Live CJ product/variant and supply data refreshed; supplier orderability and tracking capability remain unverified");
      if (liveSupplierApiVerified && !canMarkFreshVerified && typeof row.verification_error === "string" && row.verification_error.startsWith("Restored from backup; stale evidence disabled")) {
        refreshedFields.verification_error = "Live CJ product/variant and supply data refreshed; supplier orderability and tracking capability remain unverified";
        refreshedFields.verification_status = "retryable";
      }
      if (canMarkFreshVerified) {
        refreshedFields.verification_status = "verified";
        refreshedFields.last_verified_at = checkedAt.toISOString();
        if (stockCapHoldRecoverable) {
          refreshedFields.orderable = true;
          refreshedFields.verification_error = null;
        }
      }
      const { error: evidenceWriteError } = await db.from("supplier_listings").update(refreshedFields).eq("id", supplierListingId);
      if (evidenceWriteError) throw new Error("CJ recovered evidence persistence failed: " + evidenceWriteError.message);

      const missingFields = [
        !priceVerified || cost === null ? "cost" : null,
        shippingCost === null || !shippingQuoteVerified ? "shipping" : null,
        !inventoryVerified || inventory === null ? "inventory" : null,
        fxRate === null ? "fx_rate" : null,
        sellingPriceJpy === null ? "selling_price_jpy" : null,
        !imageUrl ? "image" : null,
      ].filter((field): field is string => field !== null);
      if (missingFields.length > 0) {
        const nextActions = missingFields.map((field) =>
          field === "cost" ? (currency ? "refetch_exact_cj_variant_price" : "resolve_supplier_currency_then_refetch_price") :
          field === "shipping" ? (currency ? "retry_japan_destination_freight_quote" : "resolve_supplier_currency_then_quote_freight") :
          field === "inventory" ? "refresh_exact_variant_stock_evidence" :
          field === "fx_rate" ? "refresh_supported_currency_exchange_rate" :
          field === "selling_price_jpy" ? "recalculate_landed_cost_fees_and_margin" :
          "refetch_supplier_product_image"
        );
        const nextRetryAt = new Date(checkedAt.getTime() + MISSING_DATA_RETRY_MS).toISOString();
        const { error: remediationWriteError } = await db.from("supplier_listings").update({
          metadata: {
            ...nextListingMetadata,
            missing_supply_evidence: missingFields,
            missing_supply_evidence_errors: refreshErrors.slice(0, 5),
            missing_supply_evidence_next_actions: nextActions,
            missing_supply_evidence_attempts: Math.max(0, Number(listingMetadata.missing_supply_evidence_attempts ?? 0)) + 1,
            missing_supply_evidence_last_checked_at: checkedAt.toISOString(),
            next_identity_reverify_at: nextRetryAt,
            remediation_status: "retry_scheduled",
            identity_hold_reason: "missing_economics_or_image",
          },
        }).eq("id", supplierListingId);
        if (remediationWriteError) throw new Error("CJ remediation state persistence failed: " + remediationWriteError.message);
        return { kind: "missing_economics" as const, supplierListingId, missingFields, nextActions };
      }
      // TypeScript cannot infer non-null values from the field-name array above.
      // Keep the persistence boundary explicit so only complete evidence reaches it.
      if (!priceVerified || cost === null || shippingCost === null || !shippingQuoteVerified || !inventoryVerified || inventory === null || fxRate === null || sellingPriceJpy === null || !imageUrl) {
        throw new Error("CJ evidence recovery invariant failed: required supply fields remain missing");
      }
      await persistCjSupplyIntelligence({ productId: identity?.productId ?? String(row.product_id), title: String(row.title ?? ""), imageUrl, cost, shippingCost, supplierListingId, supplierProductId: liveCanonicalSupplierProductId, supplierVariantId: String(row.supplier_variant_id), inventory, query: typeof metadata.query === "string" ? metadata.query : "identity_reverify", fxRate, sellingPriceJpy, variantBarcode, supplierIdentifiers: { gtin: row.gtin, jan: row.jan, ean: row.ean, upc: row.upc, mpn: row.mpn } });
      if (!identity) {
        const { data: latest } = await db.from("supplier_listings").select("metadata").eq("id", supplierListingId).maybeSingle();
        const latestMetadata = record(latest?.metadata);
        const checkedAt = new Date();
        await db.from("supplier_listings").update({ metadata: { ...latestMetadata, ...(variantBarcode ? { variant_barcode: variantBarcode } : {}), ...supplierBarcodeAudit(variantBarcode, normalizeIdentifier("gtin", variantBarcode ?? "") !== null), last_identity_reverify_at: checkedAt.toISOString(), next_identity_reverify_at: new Date(checkedAt.getTime() + NO_MATCH_RETRY_MS).toISOString(), identity_hold_reason: variantBarcode && normalizeIdentifier("gtin", variantBarcode) === null ? "invalid_supplier_barcode" : "no_unique_marketplace_identifier_match" } }).eq("id", supplierListingId);
      }
      return identity ? { kind: "promoted" as const, supplierListingId, bestsellerId: identity.bestsellerId, method: identity.method } : { kind: "supplier_verified" as const, supplierListingId };
    } catch (rowError) {
      if (isCJQuotaExhaustedError(rowError)) {
        return { kind: "quota_exhausted" as const, supplierListingId, error: rowError instanceof Error ? rowError.message : "CJ API quota exhausted" };
      }
      if (isCJQuotaCircuitBlockingError(rowError)) {
        return { kind: "circuit_blocked" as const, supplierListingId, error: rowError instanceof Error ? rowError.message : "CJ quota circuit state unavailable" };
      }
      const { data: latest } = await db.from("supplier_listings").select("metadata").eq("id", supplierListingId).maybeSingle();
      const latestMetadata = record(latest?.metadata);
      const checkedAt = new Date();
      const legacyParentIdMismatch = Array.isArray(latestMetadata.missing_supply_evidence_errors)
        && latestMetadata.missing_supply_evidence_errors.includes("cost:returned_variant_or_product_id_mismatch");
      await db.from("supplier_listings").update({ metadata: {
        ...latestMetadata,
        ...(legacyParentIdMismatch ? { legacy_parent_id_mismatch_retry_attempted_at: checkedAt.toISOString() } : {}),
        last_identity_reverify_at: checkedAt.toISOString(),
        next_identity_reverify_at: new Date(checkedAt.getTime() + ERROR_RETRY_MS).toISOString(),
        identity_hold_reason: "reverify_error",
      } }).eq("id", supplierListingId);
      return { kind: "error" as const, supplierListingId, error: rowError instanceof Error ? rowError.message : String(rowError) };
    }
  };
  let quotaExhausted = false;
  let circuitBlocked = false;
  for (let offset = 0; offset < selectedRows.length; offset += CONCURRENCY) {
    if (Date.now() >= deadlineAt) break;
    const batch = selectedRows.slice(offset, offset + CONCURRENCY);
    const results = await Promise.all(batch.map(processRow));
    for (const item of results) {
      result.checked += 1;
      // Advance only to an actually processed row. If the deadline interrupts a
      // batch, the next invocation resumes after the last completed supplier ID.
      // Cursor is advanced once from the bounded ID window after processing.
      if (item.kind === "promoted") {
        result.promoted += 1;
        result.promotedListings.push({ supplierListingId: item.supplierListingId, bestsellerId: item.bestsellerId, method: item.method });
      } else if (item.kind === "supplier_verified") {
        result.supplierVerified += 1;
      } else if (item.kind === "no_match") {
        result.noUniqueBarcodeMatch += 1;
      } else if (item.kind === "missing_economics") {
        result.missingEconomics += 1;
        result.remediationQueued.push({ supplierListingId: item.supplierListingId, missingFields: item.missingFields, nextActions: item.nextActions });
      } else if (item.kind === "quota_exhausted") {
        quotaExhausted = true;
        result.quotaBlockedUntil = getCJQuotaCooldownUntil();
        result.errors.push({ supplierListingId: item.supplierListingId, error: "CJ_API_QUOTA_EXHAUSTED" });
        const now = new Date().toISOString();
        const { error: circuitWriteError } = await db.from("cron_runs").insert({
          job_name: QUOTA_CIRCUIT_JOB,
          status: "succeeded",
          started_at: now,
          finished_at: now,
          processed: 0,
          failed: 1,
          metadata: { blockedUntil: result.quotaBlockedUntil, reason: "provider_explicit_daily_points_exhausted", source: "cj-identity-reverify" },
        });
        if (circuitWriteError) throw new Error("CJ quota circuit persistence failed: " + circuitWriteError.message);
      } else if (item.kind === "circuit_blocked") {
        circuitBlocked = true;
        result.errors.push({ supplierListingId: item.supplierListingId, error: "CJ_QUOTA_CIRCUIT_STATE_UNKNOWN" });
      } else {
        result.errors.push({ supplierListingId: item.supplierListingId, error: item.error });
      }
    }
    if (quotaExhausted || circuitBlocked) break;
  }
  if (quotaExhausted || circuitBlocked || targetSupplierListingIds.length > 0) {
    result.nextCursor = priorCursor;
  } else if (boundedRows.length > 0) {
    result.nextCursor = String(boundedRows[boundedRows.length - 1].id);
  }
  result.progress.after = await readCjIdentityProgressCounts(db);
  const now = new Date().toISOString();
  const { error: runInsertError } = await db.from("cron_runs").insert({ job_name: CURSOR_JOB, status: "succeeded", started_at: now, finished_at: now, processed: result.checked, failed: result.errors.length, metadata: { priorCursor, nextCursor: result.nextCursor, selectionStrategy: targetSupplierListingIds.length > 0 ? "explicit_supplier_listing_ids" : "ascending_supplier_id_cursor_safe", targetSupplierListingIds: targetSupplierListingIds.length > 0 ? targetSupplierListingIds : undefined, candidateCount: total, exactShopListingCandidates: partition.matched.length, supplierOnlyCandidates: partition.unmatched.length, womensCandidates: womensRows.length, womensSelected: selectedRows.filter((row) => isWomensProductTitle(row.title, row.metadata)).length, womenUnverifiedCandidates: womensRows.filter((row) => row.verification_status === "unverified").length, promoted: result.promoted, supplierVerified: result.supplierVerified, noUniqueBarcodeMatch: result.noUniqueBarcodeMatch, missingEconomics: result.missingEconomics, progress: result.progress, identifierFirst: true, orderableNotRequiredForIdentityRecovery: true } });
  if (runInsertError) throw new Error("CJ identity progress audit persistence failed: " + runInsertError.message);
  return result;
}
