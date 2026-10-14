import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { persistCjSupplyIntelligence, resolveMarketplaceIdentity } from "@/lib/intelligence/persist-cj-supply-intelligence";
import { calculateCJFreight, fetchCJProductVariants, fetchCJVariantByVid, fetchCJVariantStock, getCJProductDetail } from "@/lib/sources/cj";
import { isCJQuotaCircuitBlockingError, isCJQuotaExhaustedError } from "@/lib/sources/cj/client";
import { getCJQuotaCooldownUntil } from "@/lib/sources/cj/rate-limit-policy";
import { getObservedUsdToJpyRate } from "@/lib/intelligence/fx";
import { normalizeIdentifier } from "@/lib/market/identifiers";
import { isCjIdentityReverifyCandidate, isCjIdentityReverifyDue, CJ_IDENTITY_RETRY_DELAYS_MS, supplierBarcodeAudit } from "@/lib/suppliers/cj-identity-reverify-policy";

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
export type CjIdentityReverifyResult = { checked: number; promoted: number; supplierVerified: number; noUniqueBarcodeMatch: number; missingEconomics: number; errors: Array<{ supplierListingId: string; error: string }>; promotedListings: Array<{ supplierListingId: string; bestsellerId: string; method: string }>; nextCursor: string | null; quotaBlockedUntil: string | null; progress: { before: CjIdentityProgressCounts; after: CjIdentityProgressCounts } };

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
function isHttpUrl(value: unknown): value is string { return typeof value === "string" && (value.trim().startsWith("https://") || value.trim().startsWith("http://")); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
async function readPersistableBarcode(supplierProductId: string, supplierVariantId: string, persistedBarcode: string | null): Promise<string | null> {
  const supplied = typeof persistedBarcode === "string" ? persistedBarcode.trim() : "";
  if (supplied) return supplied;
  try { const variants = await fetchCJProductVariants(supplierProductId, { countryCode: "JP" }); const found = variants.find((item) => item.vid === supplierVariantId); const barcode = typeof found?.barcode === "string" ? found.barcode.trim() : ""; if (barcode) return barcode; } catch (error) { if (isCJQuotaCircuitBlockingError(error)) throw error; console.warn("[cj-identity-reverify] variant barcode lookup failed", { supplierProductId, supplierVariantId, error: error instanceof Error ? error.message : String(error) }); }
  try { const variant = await fetchCJVariantByVid(supplierVariantId); const barcode = typeof variant?.barcode === "string" ? variant.barcode.trim() : ""; return barcode || null; } catch (error) { if (isCJQuotaCircuitBlockingError(error)) throw error; console.warn("[cj-identity-reverify] queryByVid barcode lookup failed", { supplierProductId, supplierVariantId, error: error instanceof Error ? error.message : String(error) }); return null; }
}
export async function reverifyCjSupplyIdentities(options: { limit?: number; deadlineAt?: number } = {}): Promise<CjIdentityReverifyResult> {
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
  if (blockedUntil && Date.parse(blockedUntil) > Date.now()) {
    const progress = await readCjIdentityProgressCounts(db);
    return {
      checked: 0,
      promoted: 0,
      supplierVerified: 0,
      noUniqueBarcodeMatch: 0,
      missingEconomics: 0,
      errors: [{ supplierListingId: "system", error: "CJ_API_QUOTA_EXHAUSTED_COOLDOWN" }],
      promotedListings: [],
      nextCursor: null,
      quotaBlockedUntil: blockedUntil,
      progress: { before: progress, after: progress },
    };
  }
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const deadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY;
  const candidateFilter = db.from("supplier_listings").select("id", { count: "exact", head: true }).eq("supplier", "cj").in("verification_status", ["unverified", "retryable", "verified"]).in("identity_method", ["supply_discovered", "none"]).not("supplier_variant_id", "is", null);
  const { count: candidateCount, error: countError } = await candidateFilter;
  if (countError) throw new Error(`identity reverify candidate count failed: ${countError.message}`);
  const total = candidateCount ?? 0;

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
    .select("id,product_id,title,cost,shipping_cost,inventory,supplier_product_id,supplier_variant_id,identity_method,metadata,gtin,jan,ean,upc,mpn,verification_status,currency")
    .eq("supplier", "cj")
    .in("verification_status", ["unverified", "retryable", "verified"])
    .in("identity_method", ["supply_discovered", "none"])
    .not("supplier_variant_id", "is", null)
    .order("id", { ascending: true })
    .limit(MAX_CANDIDATE_SCAN);

  let rowsResult = priorCursor
    ? await buildCandidateQuery().gt("id", priorCursor)
    : await buildCandidateQuery();
  if (rowsResult.error) throw new Error(`identity reverify candidate query failed: ${rowsResult.error.message}`);

  // Scan a bounded page after the cursor. If the cursor is at the end of the
  // eligible set, wrap to the first page; never fetch the whole supplier table.
  if ((rowsResult.data ?? []).length === 0 && priorCursor) {
    rowsResult = await buildCandidateQuery();
    if (rowsResult.error) throw new Error(`identity reverify candidate wrap query failed: ${rowsResult.error.message}`);
  }

  const rows = rowsResult.data ?? [];
  const scanCursor = rows.length > 0 ? String(rows[rows.length - 1].id) : priorCursor;
  const nowMs = Date.now();
  const allRows = rows.filter((row) => isCjIdentityReverifyCandidate({ verificationStatus: row.verification_status, identityMethod: row.identity_method, supplierVariantId: row.supplier_variant_id }) && isCjIdentityReverifyDue(row.metadata, nowMs));
  const womensRows = allRows.filter((row) => isWomensProductTitle(row.title, row.metadata));
  const otherRows = allRows.filter((row) => !isWomensProductTitle(row.title, row.metadata));
  const priority = (row: typeof allRows[number]) => row.verification_status === "unverified" ? 0 : 1;
  womensRows.sort((a, b) => priority(a) - priority(b) || String(a.id).localeCompare(String(b.id)));
  otherRows.sort((a, b) => priority(a) - priority(b) || String(a.id).localeCompare(String(b.id)));
  const beforeCounts = await readCjIdentityProgressCounts(db);
  const selectedWomens = womensRows.slice(0, Math.min(limit, womensRows.length));
  const remaining = Math.max(0, limit - selectedWomens.length);
  const selectedOther = remaining > 0 ? otherRows.slice(0, Math.min(remaining, otherRows.length)) : [];
  const selectedRows = [...selectedWomens, ...selectedOther];
  const result: CjIdentityReverifyResult = { checked: 0, promoted: 0, supplierVerified: 0, noUniqueBarcodeMatch: 0, missingEconomics: 0, errors: [], promotedListings: [], nextCursor: scanCursor, quotaBlockedUntil: null, progress: { before: beforeCounts, after: beforeCounts } };
  const processRow = async (row: NonNullable<typeof rows>[number]) => {
    const supplierListingId = String(row.id);
    try {
      const listingMetadata = record(row.metadata);
      const persistedBarcode = typeof listingMetadata.variant_barcode === "string" ? listingMetadata.variant_barcode.trim() : null;
      const variantBarcode = await readPersistableBarcode(String(row.supplier_product_id), String(row.supplier_variant_id), persistedBarcode);
      const identity = await resolveMarketplaceIdentity({ db, supplierProductId: String(row.supplier_product_id), supplierVariantId: String(row.supplier_variant_id), variantBarcode, supplierIdentifiers: { gtin: row.gtin, jan: row.jan, ean: row.ean, upc: row.upc, mpn: row.mpn } });
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
      const currency = String(row.currency ?? "").trim().toUpperCase();
      const missingCost = cost === null;
      const missingShipping = shippingCost === null;
      const missingInventory = inventory === null;
      const missingImage = !imageUrl;
      let variantDetails: Awaited<ReturnType<typeof fetchCJVariantByVid>> = null;
      let productDetails: Awaited<ReturnType<typeof getCJProductDetail>> = null;
      const refreshErrors: string[] = [];

      if (missingCost && currency === "USD") {
        try {
          variantDetails = await fetchCJVariantByVid(String(row.supplier_variant_id));
          const fetchedCost = num(variantDetails?.sellPrice);
          if (fetchedCost !== null && fetchedCost > 0) cost = fetchedCost;
        } catch (error) {
          if (isCJQuotaCircuitBlockingError(error)) throw error;
          refreshErrors.push("cost:" + (error instanceof Error ? error.message : String(error)));
        }
      }
      if (missingShipping && currency === "USD") {
        try {
          const fetchedShipping = await calculateCJFreight(String(row.supplier_variant_id), { startCountryCode: "CN", endCountryCode: "JP", quantity: 1 });
          if (fetchedShipping !== null && Number.isFinite(fetchedShipping) && fetchedShipping > 0) shippingCost = fetchedShipping;
        } catch (error) {
          if (isCJQuotaCircuitBlockingError(error)) throw error;
          refreshErrors.push("shipping:" + (error instanceof Error ? error.message : String(error)));
        }
      }
      if (missingInventory) {
        try {
          const fetchedInventory = await fetchCJVariantStock(String(row.supplier_variant_id));
          if (fetchedInventory !== null && Number.isFinite(fetchedInventory) && fetchedInventory >= 0) inventory = fetchedInventory;
        } catch (error) {
          if (isCJQuotaCircuitBlockingError(error)) throw error;
          refreshErrors.push("inventory:" + (error instanceof Error ? error.message : String(error)));
        }
      }
      if (missingImage) {
        try {
          productDetails = await getCJProductDetail(String(row.supplier_product_id));
          if (isHttpUrl(productDetails?.imageUrl)) imageUrl = productDetails.imageUrl.trim();
        } catch (error) {
          if (isCJQuotaCircuitBlockingError(error)) throw error;
          refreshErrors.push("image:" + (error instanceof Error ? error.message : String(error)));
        }
      }

      const storedFxRate = num(metadata.fx_rate);
      const observedFx = storedFxRate === null && currency === "USD" ? await getObservedUsdToJpyRate() : null;
      const fxRate = storedFxRate ?? observedFx?.rate ?? null;
      const storedSellingPriceJpy = num(metadata.selling_price_jpy);
      const landedCostJpy = cost !== null && shippingCost !== null && fxRate !== null ? (cost + shippingCost) * fxRate : null;
      const sellingPriceJpy = storedSellingPriceJpy ?? (landedCostJpy !== null && Number.isFinite(landedCostJpy) && landedCostJpy >= 0 ? Math.ceil(Math.max(1980, landedCostJpy * 2.5) / 100) * 100 : null);

      const checkedAt = new Date();
      const nextListingMetadata = {
        ...listingMetadata,
        ...(variantBarcode ? { variant_barcode: variantBarcode, variant_barcode_raw: variantBarcode } : {}),
        ...(imageUrl ? { image_url: imageUrl } : {}),
        ...(cost !== null ? { recovered_cost_at: missingCost ? checkedAt.toISOString() : listingMetadata.recovered_cost_at } : {}),
        ...(shippingCost !== null ? { recovered_shipping_at: missingShipping ? checkedAt.toISOString() : listingMetadata.recovered_shipping_at } : {}),
        ...(inventory !== null ? { recovered_inventory_at: missingInventory ? checkedAt.toISOString() : listingMetadata.recovered_inventory_at } : {}),
        ...(productDetails?.imageUrl ? { recovered_image_source: "cj_product_detail" } : {}),
        last_identity_reverify_at: checkedAt.toISOString(),
      };
      const refreshedFields: Record<string, unknown> = { metadata: nextListingMetadata };
      if (missingCost && cost !== null) refreshedFields.cost = cost;
      if (missingShipping && shippingCost !== null) refreshedFields.shipping_cost = shippingCost;
      if (missingInventory && inventory !== null) refreshedFields.inventory = inventory;
      const { error: evidenceWriteError } = await db.from("supplier_listings").update(refreshedFields).eq("id", supplierListingId);
      if (evidenceWriteError) throw new Error("CJ recovered evidence persistence failed: " + evidenceWriteError.message);

      const missingFields = [
        cost === null ? "cost" : null,
        shippingCost === null ? "shipping" : null,
        inventory === null ? "inventory" : null,
        fxRate === null ? "fx_rate" : null,
        sellingPriceJpy === null ? "selling_price_jpy" : null,
        !imageUrl ? "image" : null,
      ].filter((field): field is string => field !== null);
      if (missingFields.length > 0) {
        await db.from("supplier_listings").update({
          metadata: {
            ...nextListingMetadata,
            missing_supply_evidence: missingFields,
            missing_supply_evidence_errors: refreshErrors.slice(0, 5),
            next_identity_reverify_at: new Date(checkedAt.getTime() + MISSING_DATA_RETRY_MS).toISOString(),
            identity_hold_reason: "missing_economics_or_image",
          },
        }).eq("id", supplierListingId);
        return { kind: "missing_economics" as const, supplierListingId };
      }
      // TypeScript cannot infer non-null values from the field-name array above.
      // Keep the persistence boundary explicit so only complete evidence reaches it.
      if (cost === null || shippingCost === null || inventory === null || fxRate === null || sellingPriceJpy === null || !imageUrl) {
        throw new Error("CJ evidence recovery invariant failed: required supply fields remain missing");
      }
      await persistCjSupplyIntelligence({ productId: identity?.productId ?? String(row.product_id), title: String(row.title ?? ""), imageUrl, cost, shippingCost, supplierListingId, supplierProductId: String(row.supplier_product_id), supplierVariantId: String(row.supplier_variant_id), inventory, query: typeof metadata.query === "string" ? metadata.query : "identity_reverify", fxRate, sellingPriceJpy, variantBarcode, supplierIdentifiers: { gtin: row.gtin, jan: row.jan, ean: row.ean, upc: row.upc, mpn: row.mpn } }, { identity });
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
      await db.from("supplier_listings").update({ metadata: { ...latestMetadata, last_identity_reverify_at: checkedAt.toISOString(), next_identity_reverify_at: new Date(checkedAt.getTime() + ERROR_RETRY_MS).toISOString(), identity_hold_reason: "reverify_error" } }).eq("id", supplierListingId);
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
      if (item.kind === "promoted") {
        result.promoted += 1;
        result.promotedListings.push({ supplierListingId: item.supplierListingId, bestsellerId: item.bestsellerId, method: item.method });
      } else if (item.kind === "supplier_verified") {
        result.supplierVerified += 1;
      } else if (item.kind === "no_match") {
        result.noUniqueBarcodeMatch += 1;
      } else if (item.kind === "missing_economics") {
        result.missingEconomics += 1;
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
          metadata: { blockedUntil: result.quotaBlockedUntil, reason: "provider_points_remaining_zero", source: "cj-identity-reverify" },
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
  if (quotaExhausted || circuitBlocked) result.nextCursor = priorCursor;
  result.progress.after = await readCjIdentityProgressCounts(db);
  const now = new Date().toISOString();
  const { error: runInsertError } = await db.from("cron_runs").insert({ job_name: CURSOR_JOB, status: "succeeded", started_at: now, finished_at: now, processed: result.checked, failed: result.errors.length, metadata: { priorCursor, nextCursor: result.nextCursor, selectionStrategy: "bounded_cursor_scan_womens_priority", candidateCount: total, womensCandidates: womensRows.length, womensSelected: selectedWomens.length, womenUnverifiedCandidates: womensRows.filter((row) => row.verification_status === "unverified").length, promoted: result.promoted, supplierVerified: result.supplierVerified, noUniqueBarcodeMatch: result.noUniqueBarcodeMatch, missingEconomics: result.missingEconomics, progress: result.progress, identifierFirst: true, orderableNotRequiredForIdentityRecovery: true } });
  if (runInsertError) throw new Error("CJ identity progress audit persistence failed: " + runInsertError.message);
  return result;
}
